import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  ANNOUNCEMENTS_CONVERSATION_ID,
  APP_ID,
  FILE_CHUNK_SIZE_BYTES,
  getAttachmentsDir
} from './config';
import { DbService } from './db';
import { FileTransferService } from './fileTransfer';
import { registerIpc } from './ipc';
import { NotificationService } from './notifications';
import { RelayClient, RelayEndpointSettings, RelayPeerSnapshot } from './relayClient';
import { MessageService } from './services/MessageService';
import { PresenceService } from './services/PresenceService';
import { SyncService } from './services/SyncService';
import { TrayController } from './tray';
import { AuthService } from './authService';
import {
  AckPayload,
  AnnouncementPayload,
  AppEvent,
  AuthenticatedUser,
  ClientAuthState,
  ClientRelayConfig,
  ChatTextPayload,
  ClearConversationPayload,
  DeletePayload,
  DbMessage,
  EditMessagePayload,
  FileChunkPayload,
  FileCompletePayload,
  FileRequestPayload,
  ForgetPeerPayload,
  FileOfferPayload,
  GroupEvent,
  GroupInfo,
  GroupMember,
  GroupSnapshot,
  MessageReplyPayload,
  Peer,
  Profile,
  ProtocolFrame,
  ReactPayload,
  StickerCatalogItem,
  SyncRequestPayload,
  SyncResponsePayload,
  TypingPayload
} from './types';

class LanternApp {
  private mainWindow: BrowserWindow | null = null;
  private quitting = false;
  private db!: DbService;
  private authService!: AuthService;
  private authState!: ClientAuthState;
  private profile!: Profile;
  private relay: RelayClient | null = null;
  private relaySettings: RelayEndpointSettings = {
    automatic: true,
    host: '',
    port: 43190
  };
  private fileTransfer!: FileTransferService;
  private notifications!: NotificationService;
  private tray!: TrayController;
  private presence!: PresenceService;
  private messageService!: MessageService;
  private syncService!: SyncService;
  private readonly networkMode: 'relay' = 'relay';
  private emitEvent: (event: AppEvent) => void = () => undefined;
  private peersById = new Map<string, Peer>();
  private readonly knownOnlinePeerIds = new Set<string>();
  private readonly syncRequestAtByPeer = new Map<string, number>();
  private readonly peerUnreachableFailures = new Map<string, { count: number; lastAt: number }>();
  private readonly forgottenPeersById = new Map<
    string,
    { waitingForOffline: boolean; updatedAt: number }
  >();
  private activeConversationId = ANNOUNCEMENTS_CONVERSATION_ID;
  private readonly syncRetryMinIntervalMs = 12_000;
  private readonly syncNotificationMaxAgeMs = 2 * 60 * 1000;
  private readonly peerUnreachableFailureThreshold = 2;
  private readonly peerUnreachableFailureWindowMs = 15_000;
  private readonly editWindowMs = 10 * 60 * 1000;
  private readonly groupUploadWindowSize = 4;
  private syncActivityCount = 0;
  private syncIdleTimer: NodeJS.Timeout | null = null;
  private readonly syncIdleGraceMs = 450;
  private incomingFrameQueue: Promise<void> = Promise.resolve();
  private readonly groupFileDownloadByRequestId = new Map<
    string,
    { fileId: string; groupId: string; messageId: string; senderDeviceId: string }
  >();
  private readonly groupFileDownloadRequestIdByFileId = new Map<string, string>();
  private readonly groupFileDownloadCompletionByFileId = new Map<
    string,
    { promise: Promise<void>; resolve: () => void }
  >();
  private readonly groupFileDownloadTimeoutByRequestId = new Map<string, NodeJS.Timeout>();
  private readonly groupFileDownloadRetryTimerByFileId = new Map<string, NodeJS.Timeout>();
  private readonly groupFileDownloadStartTimeoutMs = 20_000;
  private readonly groupFileDownloadMaxRetries = 3;
  private readonly groupFileUploadsInFlight = new Set<string>();
  private readonly directFileRequestAtByMessageId = new Map<string, number>();
  private readonly directFileRequestInFlight = new Set<string>();
  private readonly directFileRequestMinIntervalMs = 5_000;

  private getDefaultAttachmentsDir(): string {
    return path.resolve(getAttachmentsDir(app.getPath('documents')));
  }

  private resolveAppIconPath(): string | null {
    const preferredIconFiles =
      process.platform === 'darwin'
        ? ['icon.icns', 'icon.png']
        : process.platform === 'win32'
        ? ['icon.ico', 'icon.png']
        : ['icon.png'];

    const candidates: string[] = [];
    for (const iconFile of preferredIconFiles) {
      candidates.push(
        path.join(app.getAppPath(), 'assets', iconFile),
        path.join(__dirname, '..', 'assets', iconFile),
        path.join(process.cwd(), 'assets', iconFile),
        path.join(process.resourcesPath, 'assets', iconFile),
        path.join(process.resourcesPath, 'app.asar', 'assets', iconFile),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', iconFile),
        path.join(app.getAppPath(), 'build', iconFile),
        path.join(__dirname, '..', 'build', iconFile),
        path.join(process.cwd(), 'build', iconFile),
        path.join(process.resourcesPath, 'build', iconFile),
        path.join(process.resourcesPath, 'app.asar', 'build', iconFile),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'build', iconFile)
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private getConfiguredAttachmentsDir(): string {
    return this.db.getAttachmentsDirectory(this.getDefaultAttachmentsDir());
  }

  private async saveFileAs(filePath: string, fileName?: string): Promise<void> {
    const sourcePath = path.resolve(filePath || '');
    if (!sourcePath) return;

    const sourceStats = await fs.promises.stat(sourcePath).catch(() => null);
    if (!sourceStats?.isFile()) {
      throw new Error('Arquivo não encontrado para salvar cópia.');
    }

    const suggestedName = (fileName || '').trim() || path.basename(sourcePath) || 'arquivo';
    const saveDialogOptions = {
      title: 'Salvar anexo como',
      buttonLabel: 'Salvar',
      defaultPath: path.join(app.getPath('documents'), suggestedName)
    };
    const result = this.mainWindow
      ? await dialog.showSaveDialog(this.mainWindow, saveDialogOptions)
      : await dialog.showSaveDialog(saveDialogOptions);

    const destination = result.filePath ? path.resolve(result.filePath) : '';
    if (result.canceled || !destination) {
      return;
    }

    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(sourcePath, destination);
  }

  private profileFromAccount(user: AuthenticatedUser): Profile {
    const now = Date.now();
    return {
      deviceId: user.userId,
      username: user.username,
      department: user.department,
      displayName: user.displayName,
      avatarEmoji: user.avatarEmoji || '🙂',
      avatarBg: user.avatarBg || '#147ad6',
      statusMessage: user.statusMessage || 'Disponível',
      createdAt: now,
      updatedAt: now
    };
  }

  private async login(input: {
    relay: ClientRelayConfig;
    username: string;
    password: string;
  }): Promise<ClientAuthState> {
    const state = await this.authService.login(input);
    return this.applyAuthenticatedState(state);
  }

  private async applyAuthenticatedState(state: ClientAuthState): Promise<ClientAuthState> {
    if (!state.user || !state.endpoint || !this.authService.getToken()) {
      throw new Error('O Relay não retornou uma sessão válida.');
    }
    const authenticatedProfile = this.profileFromAccount(state.user);
    this.db.resetCacheForAuthenticatedProfile(authenticatedProfile);
    Object.assign(this.profile, authenticatedProfile);
    this.authState = state;
    this.relay?.stop();
    this.relay?.setAuthenticatedSession(this.profile, this.authService.getToken()!);
    this.relay?.setDirectRelayEndpoint(state.endpoint);
    await this.relay?.start();
    this.emitEvent({ type: 'auth:changed', state });
    return state;
  }

  private async logout(): Promise<void> {
    this.relay?.stop();
    await this.authService.logout();
    this.authState = this.authService.getState();
    this.db.clearCachedUserData();
    this.peersById.clear();
    this.knownOnlinePeerIds.clear();
    this.presence.clearOnlinePeers();
    await fs.promises
      .rm(this.getConfiguredAttachmentsDir(), { recursive: true, force: true })
      .catch(() => undefined);
    await fs.promises.mkdir(this.getConfiguredAttachmentsDir(), { recursive: true });
    this.emitEvent({ type: 'peers:updated', peers: [] });
    this.emitEvent({ type: 'auth:changed', state: this.authState });
  }

  async start(): Promise<void> {
    app.setName('Lantern Central');
    app.setAppUserModelId(APP_ID);
    const appIconPath = this.resolveAppIconPath();
    if (process.platform === 'darwin' && appIconPath) {
      try {
        app.dock?.setIcon(appIconPath);
      } catch {
        // ignore
      }
    }

    this.db = new DbService(app.getPath('userData'));
    this.authService = new AuthService(app.getPath('userData'));
    this.authState = await this.authService.restore();
    const cachedProfile = this.db.getProfile();
    if (this.authState.user) {
      const authenticatedProfile = this.profileFromAccount(this.authState.user);
      if (cachedProfile.deviceId !== authenticatedProfile.deviceId) {
        this.db.resetCacheForAuthenticatedProfile(authenticatedProfile);
      } else {
        this.db.updateProfile(authenticatedProfile);
      }
      this.profile = { ...authenticatedProfile };
    } else {
      this.profile = cachedProfile;
    }
    this.relaySettings = this.db.getRelaySettings();
    this.presence = new PresenceService();
    this.syncService = new SyncService(this.db, this.profile);

    this.mainWindow = this.createWindow();
    this.notifications = new NotificationService(() => this.mainWindow);
    this.tray = new TrayController();
    this.fileTransfer = new FileTransferService(this.getConfiguredAttachmentsDir(), this.profile);

    this.relay = new RelayClient(this.profile, {
      onFrame: (frame) => {
        this.enqueueIncomingFrame(frame);
      },
      onHistorySnapshot: (frames) => {
        void this.applyCanonicalHistorySnapshot(frames).catch((error) => {
          console.error('[Lantern][Relay] falha ao aplicar histórico canônico:', error);
        });
      },
      onPresence: (peers) => {
        try {
          this.handleRelayPresence(peers);
        } catch (error) {
          console.error(
            '[Lantern][Relay] falha ao processar presença:',
            error instanceof Error ? error.message : String(error)
          );
        }
      },
      onDirectory: (peers) => {
        for (const peer of peers) {
          const cached: Peer = {
            ...peer,
            address: '',
            port: 0,
            source: 'cache',
            lastSeenAt: peer.lastSeenAt || 0
          };
          this.peersById.set(peer.deviceId, cached);
          this.db.upsertPeerCache(cached);
        }
        this.emitEvent({ type: 'peers:updated', peers: this.getKnownPeers() });
      },
      onAnnouncementExpired: (messageIds) => {
        this.handleRelayAnnouncementExpiry(messageIds);
      },
      onAnnouncementSnapshot: (frames, reactions, reads) => {
        void this.handleRelayAnnouncementSnapshot(frames, reactions, reads).catch((error) => {
          if (process.env.LANTERN_DEBUG_DISCOVERY === '1') {
            console.warn(
              '[Lantern][Relay] falha ao aplicar snapshot de anúncios:',
              error instanceof Error ? error.message : String(error)
            );
          }
        });
      },
      onAnnouncementReactions: (messageId, reactions) => {
        this.handleRelayAnnouncementReactionUpdate(messageId, reactions);
      },
      onAnnouncementReads: (reads) => {
        this.handleRelayAnnouncementReadUpdate(reads);
      },
      onGroupSnapshot: (snapshots) => {
        this.handleGroupSnapshots(snapshots);
      },
      onGroupEvent: (event) => {
        this.handleGroupEvent(event);
      },
      onGroupFileStart: (payload) => {
        this.handleGroupFileStart(payload);
      },
      onGroupFileChunk: (payload) => {
        this.handleGroupFileChunk(payload);
      },
      onGroupFileComplete: (payload) => {
        void this.handleGroupFileComplete(payload).catch((error) => {
          console.warn(
            '[Lantern][Relay] falha ao finalizar anexo de grupo:',
            error instanceof Error ? error.message : String(error)
          );
        });
      },
      onGroupFileRequestFailed: (payload) => {
        this.failGroupFileDownload(payload.requestId, payload.message);
      },
      onConnectionState: ({ connected, endpoint }) => {
        this.emitEvent({
          type: 'relay:connection',
          connected,
          endpoint
        });
        if (!connected) {
          void this.pauseGroupFileDownloadsForDisconnect();
          this.knownOnlinePeerIds.clear();
          if (this.presence.clearOnlinePeers()) {
            this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
          }
          this.emitEvent({
            type: 'ui:toast',
            level: 'warning',
            message: 'Conexão com Relay perdida. Tentando reconectar...'
          });
          return;
        }
        this.emitEvent({
          type: 'ui:toast',
          level: 'success',
          message: endpoint
            ? `Conectado ao Relay (${endpoint})`
            : 'Conectado ao Relay'
        });
        void (async () => {
          try {
            await this.relay?.syncGroups(this.db.getGroupSeqMap());
            // Primeiro aplicamos o snapshot canônico; depois retomamos uploads/downloads locais.
            await this.resumePendingGroupFiles();
            await this.resumePendingGroupAttachmentDownloads();
          } catch (error) {
            console.warn(
              '[Lantern][Relay] falha ao sincronizar ou retomar dados de grupos:',
              error instanceof Error ? error.message : String(error)
            );
          }
        })();
      },
      onWarning: (message) => {
        this.emitEvent({ type: 'ui:toast', level: 'warning', message });
      }
    }, this.authService.getToken() || '');

    // Importante: inicializar MessageService antes de conectar no relay.
    // O relay pode emitir presença/frames imediatamente após start()
    // e esses handlers dependem de messageService já pronto.
    this.messageService = new MessageService({
      db: this.db,
      profile: this.profile,
      sendToPeer: (peer, frame) => this.sendToPeer(peer, frame),
      sendBroadcast: (frame) => this.sendBroadcast(frame),
      fileTransfer: this.fileTransfer,
      getPeer: (peerId) => this.presence.getPeer(peerId),
      getOnlinePeers: () => this.presence.getOnlinePeers(),
      onPeerUnreachable: (peerId) => this.markPeerUnreachable(peerId, { force: true }),
      emitEvent: (event) => this.emitEvent(event)
      ,sendCanonicalFrame: async (frame) => {
        if (!this.relay?.isConnected()) throw new Error('Relay offline.');
        await this.relay.sendFrame(frame);
      },
      uploadCanonicalAttachment: async ({ message, offer, filePath, onProgress }) => {
        if (!this.relay) throw new Error('Relay indisponível.');
        await this.relay.uploadCentralAttachment({
          attachmentId: offer.fileId,
          messageId: message.messageId,
          conversationId: message.conversationId,
          fileName: offer.filename,
          size: offer.size,
          sha256: offer.sha256,
          chunks: this.fileTransfer.createChunkStream(filePath, offer.fileId),
          onProgress
        });
      }
    });

    if (this.authState.endpoint) {
      this.relay.setDirectRelayEndpoint(this.authState.endpoint);
    } else {
      this.relay.setEndpointSettings(this.relaySettings);
    }

    this.notifications.setNavigateHandler((conversationId) => {
      this.mainWindow?.show();
      this.mainWindow?.focus();
      this.emitEvent({ type: 'navigate', conversationId });
    });
    this.notifications.setDoNotDisturbUntil(this.db.getDoNotDisturbUntil());

    const ipc = registerIpc(this.mainWindow, {
      getAuthState: () => this.authState,
      discoverRelays: (port) => this.authService.discover(port),
      login: (input) => this.login(input),
      register: async (input) => {
        const state = await this.authService.register(input);
        return this.applyAuthenticatedState(state);
      },
      logout: () => this.logout(),
      getProfile: () => this.profile,
      updateProfile: (input) => {
        const updated = this.db.updateProfile(input);
        Object.assign(this.profile, updated);
        this.relay?.updateProfile(this.profile);
        return this.profile;
      },
      getKnownPeers: () => this.getKnownPeers(),
      getOnlinePeers: () => this.getVisibleOnlinePeers(),
      getGroups: () => this.getVisibleGroups(),
      getGroupMembers: (groupId) => this.db.getGroupMembers(groupId),
      getGroupPinnedMessageIds: (groupId) => this.db.getGroupPinnedMessageIds(groupId),
      createGroup: (input) => this.createGroup(input),
      updateGroup: (groupId, input) => this.updateGroup(groupId, input),
      addGroupMembers: (groupId, memberDeviceIds) => this.addGroupMembers(groupId, memberDeviceIds),
      removeGroupMember: (groupId, deviceId) => this.removeGroupMember(groupId, deviceId),
      setGroupMemberRole: (groupId, deviceId, role) => this.setGroupMemberRole(groupId, deviceId, role),
      transferGroupOwnership: (groupId, deviceId) => this.transferGroupOwnership(groupId, deviceId),
      deleteGroup: (groupId) => this.deleteGroup(groupId),
      leaveGroup: (groupId) => this.leaveGroup(groupId),
      setGroupMessagePinned: (groupId, messageId, pinned) =>
        this.setGroupMessagePinned(groupId, messageId, pinned),
      getRelaySettings: () => this.getRelaySettingsSnapshot(),
      getStartupSettings: () => this.getStartupSettingsSnapshot(),
      updateRelaySettings: (input) => this.updateRelaySettings(input),
      forceRelayRediscovery: () => this.forceRelayRediscovery(),
      updateStartupSettings: (input) => this.updateStartupSettings(input),
      sendText: (peerId, text, replyTo) => this.messageService.sendText(peerId, text, replyTo),
      sendGroupText: (groupId, text, replyTo) => this.sendGroupText(groupId, text, replyTo),
      sendTyping: (peerId, isTyping) => this.sendTyping(peerId, isTyping),
      sendAnnouncement: (text, replyTo) => this.messageService.sendAnnouncement(text, replyTo),
      sendFile: (peerId, filePath, replyTo) => this.messageService.sendFile(peerId, filePath, replyTo),
      sendGroupFile: (groupId, filePath, replyTo) => this.sendGroupFile(groupId, filePath, replyTo),
      forwardMessageToPeer: (targetPeerId, sourceMessageId) =>
        this.forwardMessageToPeer(targetPeerId, sourceMessageId),
      editMessage: (conversationId, messageId, text) =>
        this.editMessage(conversationId, messageId, text),
      reactToMessage: (conversationId, messageId, reaction) =>
        this.reactToMessage(conversationId, messageId, reaction),
      deleteMessageForEveryone: (conversationId, messageId) =>
        this.deleteMessageForEveryone(conversationId, messageId),
      deleteMessageForMe: async (conversationId, messageId) =>
        this.deleteMessageForMe(conversationId, messageId),
      toggleMessageFavorite: (conversationId, messageId, favorite) =>
        this.toggleMessageFavorite(conversationId, messageId, favorite),
      getMessageFavorites: (messageIds) => this.db.getMessageFavoritesMap(messageIds),
      getFavoriteMessages: (conversationId) => this.db.getFavoriteMessages(conversationId),
      resyncConversation: (conversationId) => this.resyncConversation(conversationId),
      getMessages: (conversationId, limit, before) => this.db.getMessages(conversationId, limit, before),
      getMessagesByIds: (messageIds) => this.db.getMessagesByIds(messageIds),
      searchConversationMessageIds: (conversationId, query, limit, offset) =>
        this.db.searchConversationMessageIds(conversationId, query, limit, offset),
      getConversationPreviews: (conversationIds) => this.db.getConversationPreviews(conversationIds),
      getMessageReactions: (messageIds) =>
        this.db.getMessageReactionSummary(messageIds, this.profile.deviceId),
      getAnnouncementReactions: (messageIds) =>
        this.db.getMessageReactionSummary(messageIds, this.profile.deviceId),
      getAnnouncementReactionDetails: (messageId) =>
        this.db.getMessageReactionDetails(messageId),
      getMessageReactionDetails: (messageId) => this.db.getMessageReactionDetails(messageId),
      getAnnouncementReadSummary: (messageIds) =>
        this.db.getAnnouncementReadSummary(messageIds, this.profile.deviceId),
      getAnnouncementReadDetails: (messageId) =>
        this.db.getAnnouncementReadDetails(messageId),
      getRelayStickers: () => this.getRelayStickers(),
      prepareRelayStickerFile: (fileName) => this.prepareRelayStickerFile(fileName),
      exportConversation: (conversationId, format) =>
        this.exportConversation(conversationId, format),
      setActiveConversation: (conversationId) => {
        this.activeConversationId = conversationId;
        this.markConversationRead(conversationId);
      },
      markConversationRead: (conversationId) => this.markConversationRead(conversationId),
      markConversationUnread: (conversationId) => this.markConversationUnread(conversationId),
      archiveConversation: (conversationId) => this.db.setConversationArchived(conversationId, true),
      unarchiveConversation: (conversationId) => this.db.setConversationArchived(conversationId, false),
      clearConversation: (conversationId) => this.clearConversation(conversationId),
      forgetContactConversation: (conversationId) => this.forgetContactConversation(conversationId),
      getConversations: () =>
        Object.fromEntries(
          this.db
            .getConversations()
            .map((conversation) => [conversation.id, conversation.unreadCount])
        ),
      getArchivedConversationIds: () => this.db.getArchivedConversationIds(),
      addManualPeer: (address, port) => {
        try {
          this.updateRelaySettings({
            automatic: false,
            host: address,
            port
          });
        } catch (error) {
          if (process.env.LANTERN_DEBUG_DISCOVERY === '1') {
            console.warn(
              '[Lantern] falha ao atualizar relay manual:',
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      },
      saveFileAs: (filePath, fileName) => this.saveFileAs(filePath, fileName)
    });

    this.emitEvent = ipc.emitEvent;
    this.emitEvent({
      type: 'relay:connection',
      connected: this.relay?.isConnected() || false,
      endpoint: this.relay?.getCurrentEndpoint() || null
    });
    this.emitEvent({ type: 'sync:status', active: this.syncActivityCount > 0 });
    this.reconcileLegacyIncomingFilePaths();

    if (this.authState.authenticated) void this.relay.start().then(() => {
      this.emitEvent({
        type: 'relay:connection',
        connected: this.relay?.isConnected() || false,
        endpoint: this.relay?.getCurrentEndpoint() || null
      });
    }).catch((error) => {
      console.error(
        '[Lantern][Relay] falha ao iniciar cliente relay:',
        error instanceof Error ? error.message : String(error)
      );
      this.emitEvent({
        type: 'ui:toast',
        level: 'warning',
        message: 'Não foi possível iniciar conexão com o Relay. A UI continua disponível.'
      });
    });

    if (process.env.LANTERN_DEBUG_DISCOVERY === '1') {
      console.log(
        '[Lantern] startup',
        JSON.stringify({
          mode: this.networkMode,
          instance: process.env.LANTERN_INSTANCE || null,
          userData: app.getPath('userData'),
          deviceId: this.profile.deviceId
        })
      );
    }

    this.tray.create(this.mainWindow, {
      appName: 'Lantern',
      onQuit: () => {
        this.quitting = true;
        app.quit();
      },
      onMuteChange: (muted) => this.notifications.setMuted(muted),
      isMuted: () => this.notifications.isMuted()
    });

    this.mainWindow.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        this.tray.hideToTray(this.mainWindow!);
      }
    });

    app.on('before-quit', () => {
      this.quitting = true;
      this.cleanup();
    });

    app.on('window-all-closed', () => {
      if (this.quitting) {
        app.quit();
      }
    });
  }

  private createWindow(): BrowserWindow {
    const isMac = process.platform === 'darwin';
    const isWin = process.platform === 'win32';
    const appIconPath = this.resolveAppIconPath();

    if (isWin) {
      Menu.setApplicationMenu(null);
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 980,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: isMac ? '#f2f2f7' : '#f4f8ff',
      titleBarStyle: 'default',
      vibrancy: undefined,
      visualEffectState: undefined,
      titleBarOverlay: isWin
        ? {
            color: '#00000000',
            symbolColor: '#5c6d88',
            height: 36
          }
        : false,
      icon: appIconPath || undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js')
      }
    });

    window.once('ready-to-show', () => window.show());
    if (isWin) {
      window.removeMenu();
      window.setMenuBarVisibility(false);
    }

    const devServer = process.env.VITE_DEV_SERVER_URL;
    if (devServer) {
      void window.loadURL(devServer);
    } else {
      const candidates = [
        path.join(app.getAppPath(), 'dist-renderer', 'index.html'),
        path.join(__dirname, '..', 'dist-renderer', 'index.html')
      ];
      const target = candidates.find((candidate) => fs.existsSync(candidate));
      if (!target) {
        console.error('[Lantern] index.html não encontrado. Caminhos testados:', candidates);
      } else {
        void window.loadFile(target);
      }
    }

    window.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        console.error(
          '[Lantern] Falha ao carregar renderer',
          JSON.stringify({ errorCode, errorDescription, validatedURL })
        );
      }
    );

    return window;
  }

  private getPeer(peerId: string): Peer {
    const peer = this.resolvePeerForTransport(peerId);
    if (!peer) {
      throw new Error('Peer não encontrado no Relay.');
    }
    return peer;
  }

  private getKnownPeers(): Peer[] {
    return this.presence
      .getKnownPeers(this.db, this.profile)
      .filter((peer) => !this.isPeerForgotten(peer.deviceId));
  }

  private getVisibleOnlinePeers(): Peer[] {
    return this.presence
      .getOnlinePeers()
      .filter((peer) => !this.isPeerForgotten(peer.deviceId));
  }

  private getRelaySettingsSnapshot(): {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  } {
    const settings = this.relaySettings;
    return {
      automatic: settings.automatic,
      host: settings.host,
      port: settings.port,
      connected: this.relay?.isConnected() || false,
      endpoint: this.relay?.getCurrentEndpoint() || null
    };
  }

  private isStartupSettingsSupported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin';
  }

  private getStartupSettingsSnapshot(): {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
    doNotDisturbUntil: number;
  } {
    const supported = this.isStartupSettingsSupported();
    const downloadsDir =
      this.fileTransfer?.getAttachmentsDir?.() || this.getConfiguredAttachmentsDir();
    const doNotDisturbUntil = this.db.getDoNotDisturbUntil();
    if (!supported) {
      return { supported: false, openAtLogin: false, downloadsDir, doNotDisturbUntil };
    }
    const settings = app.getLoginItemSettings();
    return {
      supported: true,
      openAtLogin: Boolean(settings.openAtLogin),
      downloadsDir,
      doNotDisturbUntil
    };
  }

  private updateStartupSettings(input: {
    openAtLogin: boolean;
    downloadsDir?: string;
    doNotDisturbUntil?: number;
  }): {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
    doNotDisturbUntil: number;
  } {
    const defaultAttachmentsDir = this.getDefaultAttachmentsDir();
    const requestedDir = (input.downloadsDir || '').trim();
    if (requestedDir.length > 0) {
      const nextDir = this.db.setAttachmentsDirectory(requestedDir, defaultAttachmentsDir);
      this.fileTransfer.setAttachmentsDir(nextDir);
    }

    if (typeof input.doNotDisturbUntil === 'number') {
      const nextDndUntil = this.db.setDoNotDisturbUntil(input.doNotDisturbUntil);
      this.notifications.setDoNotDisturbUntil(nextDndUntil);
    }

    const supported = this.isStartupSettingsSupported();
    if (!supported) {
      return this.getStartupSettingsSnapshot();
    }

    const openAtLogin = Boolean(input.openAtLogin);
    app.setLoginItemSettings({
      openAtLogin,
      openAsHidden: false
    });
    return this.getStartupSettingsSnapshot();
  }

  private updateRelaySettings(input: {
    automatic: boolean;
    host?: string;
    port?: number;
  }): {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  } {
    const automatic = Boolean(input.automatic);
    const host = (input.host || '').trim();
    const rawPort = Number(input.port || 0);
    const port =
      Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535
        ? Math.trunc(rawPort)
        : 43190;

    if (!automatic && host.length === 0) {
      throw new Error('Informe o host/IP do Relay para usar o modo manual.');
    }

    const persisted = this.db.setRelaySettings({
      automatic,
      host,
      port
    });
    this.relaySettings = persisted;
    this.relay?.setEndpointSettings(persisted);

    return this.getRelaySettingsSnapshot();
  }

  private forceRelayRediscovery(): {
    automatic: boolean;
    host: string;
    port: number;
    connected: boolean;
    endpoint: string | null;
  } {
    this.relay?.forceRediscover();
    const snapshot = this.getRelaySettingsSnapshot();
    this.emitEvent({
      type: 'relay:connection',
      connected: snapshot.connected,
      endpoint: snapshot.endpoint
    });
    return snapshot;
  }

  private getRelayHttpBaseUrl(): string {
    const endpoint = this.relay?.getCurrentEndpoint();
    if (!this.relay?.isConnected() || !endpoint) {
      throw new Error('Relay desconectado.');
    }
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  private normalizeRelayStickerRelativePath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\\/g, '/');
    if (
      !/^(?:[a-z0-9][a-z0-9._ -]*\.gif|[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._ -]*\.gif)$/i.test(
        normalized
      )
    ) {
      return null;
    }
    return normalized;
  }

  private buildRelayStickerUrl(baseUrl: string, relativePath: string, version: string): string {
    const encodedPath = relativePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return `${baseUrl}/stickers/${encodedPath}?v=${encodeURIComponent(version)}`;
  }

  private async fetchRelayStickerBuffer(
    baseUrl: string,
    relativePath: string,
    version: string
  ): Promise<Buffer | null> {
    try {
      const response = await fetch(this.buildRelayStickerUrl(baseUrl, relativePath, version));
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) return null;
      const signature = buffer.subarray(0, 6).toString('ascii');
      return signature === 'GIF87a' || signature === 'GIF89a' ? buffer : null;
    } catch {
      return null;
    }
  }

  private async getRelayStickers(): Promise<StickerCatalogItem[]> {
    const baseUrl = this.getRelayHttpBaseUrl();
    const response = await fetch(`${baseUrl}/stickers`);
    if (!response.ok) {
      throw new Error('Não foi possível carregar GIFs do Relay.');
    }
    const payload = (await response.json()) as { stickers?: Array<Record<string, unknown>> };
    const stickers = Array.isArray(payload.stickers) ? payload.stickers : [];
    const catalog: StickerCatalogItem[] = stickers
      .map((item): StickerCatalogItem | null => {
        const relativePath = this.normalizeRelayStickerRelativePath(item.relativePath);
        if (!relativePath) return null;
        const fileName = path.posix.basename(relativePath);
        const size =
          typeof item.size === 'number' && Number.isFinite(item.size)
            ? Math.max(0, Math.trunc(item.size))
            : 0;
        const updatedAt =
          typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)
            ? Math.max(0, Math.trunc(item.updatedAt))
            : 0;
        const label =
          typeof item.label === 'string' && item.label.trim()
            ? item.label.trim()
            : fileName.replace(/\.gif$/i, '').replace(/[-_]+/g, ' ');
        const category = relativePath.includes('/') ? relativePath.split('/')[0] : 'geral';
        return {
          id: `${relativePath}:${updatedAt}:${size}`,
          label,
          fileName,
          relativePath,
          url: this.buildRelayStickerUrl(baseUrl, relativePath, `${updatedAt}-${size}`),
          previewDataUrl: null,
          size,
          category,
          updatedAt
        };
      })
      .filter((item): item is StickerCatalogItem => item !== null)
      .sort((left, right) => {
        const categoryOrder = left.category.localeCompare(right.category, 'pt-BR');
        return categoryOrder !== 0 ? categoryOrder : left.label.localeCompare(right.label, 'pt-BR');
      });

    return Promise.all(
      catalog.map(async (sticker) => {
        const buffer = await this.fetchRelayStickerBuffer(
          baseUrl,
          sticker.relativePath,
          `${sticker.updatedAt}-${sticker.size}`
        );
        return {
          ...sticker,
          // A CSP do renderer não precisa liberar hosts arbitrários do Relay.
          previewDataUrl: buffer ? `data:image/gif;base64,${buffer.toString('base64')}` : null
        };
      })
    );
  }

  private async prepareRelayStickerFile(relativePathInput: string): Promise<string | null> {
    const relativePath = this.normalizeRelayStickerRelativePath(relativePathInput);
    if (!relativePath) {
      return null;
    }

    const baseUrl = this.getRelayHttpBaseUrl();
    const buffer = await this.fetchRelayStickerBuffer(baseUrl, relativePath, 'download');
    if (!buffer) return null;

    const tempDir = path.join(os.tmpdir(), 'lantern-stickers');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const sourceName = path.posix.basename(relativePath, '.gif');
    const stickerSlug =
      sourceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'gif';
    const targetPath = path.join(
      tempDir,
      // O marcador permite que qualquer GIF do catálogo tenha apresentação de figurinha no chat.
      `lantern-sticker-${stickerSlug}-${Date.now()}-${randomUUID()}.gif`
    );
    await fs.promises.writeFile(targetPath, buffer);
    return targetPath;
  }

  private handleRelayPresence(relayPeers: RelayPeerSnapshot[]): void {
    const now = Date.now();
    const incomingIds = new Set<string>();
    let changed = false;

    const discoveredPeerIds = new Set(
      relayPeers
        .map((peer) => peer.deviceId)
        .filter((peerId) => peerId && peerId !== this.profile.deviceId)
    );
    if (this.updateForgottenPeers(discoveredPeerIds, now)) {
      changed = true;
    }

    for (const relayPeer of relayPeers) {
      if (!relayPeer.deviceId || relayPeer.deviceId === this.profile.deviceId) continue;

      const peer: Peer = {
        deviceId: relayPeer.deviceId,
        displayName: relayPeer.displayName || `User ${relayPeer.deviceId.slice(0, 6)}`,
        avatarEmoji: relayPeer.avatarEmoji || '🙂',
        avatarBg: relayPeer.avatarBg || '#5b5fc7',
        statusMessage: relayPeer.statusMessage || 'Disponível',
        username: relayPeer.username || '',
        department: relayPeer.department || '',
        address: '',
        port: 0,
        appVersion: relayPeer.appVersion || 'unknown',
        lastSeenAt:
          Number.isFinite(relayPeer.lastSeenAt) && relayPeer.lastSeenAt > 0
            ? Math.trunc(relayPeer.lastSeenAt)
            : now,
        source: 'relay'
      };

      const hasPendingOps = this.db.getPendingPeerOperations(peer.deviceId).length > 0;
      if (this.isPeerForgotten(peer.deviceId)) {
        if (hasPendingOps) {
          void this.flushPendingPeerOperations(peer.deviceId, peer).catch(() => undefined);
        }
        continue;
      }

      incomingIds.add(peer.deviceId);
      const wasOnline = this.knownOnlinePeerIds.has(peer.deviceId);

      const touched = this.presence.touchOnlinePeer(peer, this.db, { bypassCooldown: true });
      if (touched) {
        changed = true;
      }

      this.peersById.set(peer.deviceId, this.presence.getPeer(peer.deviceId) || peer);
      this.knownOnlinePeerIds.add(peer.deviceId);
      this.peerUnreachableFailures.delete(peer.deviceId);

      // Evita tempestade de sync: só sincroniza quando o peer transita de offline -> online.
      if (!wasOnline) {
        void this.flushPendingPeerOperations(peer.deviceId, peer).catch(() => undefined);
        void this.requestSync(peer).catch(() => undefined);
        void this.messageService.retryFailedMessagesForPeer(peer).catch(() => undefined);
        void this.messageService.replayPendingFilesForPeer(peer).catch(() => undefined);
        this.requestMissingDirectAttachmentsForPeer(peer);
      } else if (hasPendingOps) {
        void this.flushPendingPeerOperations(peer.deviceId, peer).catch(() => undefined);
      }
    }

    for (const knownOnlinePeerId of Array.from(this.knownOnlinePeerIds.values())) {
      if (incomingIds.has(knownOnlinePeerId)) {
        continue;
      }
      if (this.dropPeerRuntimeState(knownOnlinePeerId)) {
        changed = true;
      }
    }

    if (changed) {
      this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
    }
  }

  private isPeerForgotten(peerId: string): boolean {
    return this.forgottenPeersById.has(peerId);
  }

  private updateForgottenPeers(discoveredPeerIds: Set<string>, now: number): boolean {
    let becameVisible = false;

    for (const [peerId, state] of Array.from(this.forgottenPeersById.entries())) {
      const reachableNow = discoveredPeerIds.has(peerId);

      if (state.waitingForOffline) {
        if (!reachableNow) {
          this.forgottenPeersById.set(peerId, {
            waitingForOffline: false,
            updatedAt: now
          });
        } else {
          this.dropPeerRuntimeState(peerId);
        }
        continue;
      }

      if (reachableNow) {
        this.forgottenPeersById.delete(peerId);
        becameVisible = true;
        continue;
      }

      if (now - state.updatedAt > 24 * 60 * 60 * 1000) {
        this.forgottenPeersById.delete(peerId);
      }
    }

    return becameVisible;
  }

  private getPeerFromConversationId(conversationId: string): Peer | null {
    if (!conversationId.startsWith('dm:')) return null;
    const peerId = conversationId.slice(3);
    return this.resolvePeerForTransport(peerId) || null;
  }

  private resolvePeerForTransport(peerId: string): Peer | undefined {
    if (this.isPeerForgotten(peerId)) {
      return undefined;
    }
    const online = this.presence.getPeer(peerId);
    if (online) return online;

    const known = this.peersById.get(peerId);
    if (known) return known;

    const cached = this.db.getCachedPeerById(peerId);
    if (cached) {
      return {
        ...cached,
        source: cached.source || 'cache',
        lastSeenAt: cached.lastSeenAt || Date.now()
      };
    }

    return undefined;
  }

  private async requestSync(
    peer: Peer,
    options?: {
      force?: boolean;
      throwOnFail?: boolean;
      since?: number;
      limit?: number;
      fullResync?: boolean;
    }
  ): Promise<void> {
    const now = Date.now();
    const force = Boolean(options?.force);
    const throwOnFail = Boolean(options?.throwOnFail);
    const fullResync = Boolean(options?.fullResync);
    const last = this.syncRequestAtByPeer.get(peer.deviceId) || 0;
    if (!force && now - last < this.syncRetryMinIntervalMs) {
      return;
    }
    this.syncRequestAtByPeer.set(peer.deviceId, now);

    const normalizedSince =
      typeof options?.since === 'number' && Number.isFinite(options.since) && options.since >= 0
        ? Math.trunc(options.since)
        : this.db.getLatestRelevantMessageTimestamp(peer.deviceId);
    const normalizedLimit =
      typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : 1000;

    const frame: ProtocolFrame<SyncRequestPayload> = {
      type: 'chat:sync:request',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: peer.deviceId,
      createdAt: now,
      payload: {
        since: normalizedSince,
        limit: normalizedLimit,
        fullResync
      }
    };

    this.beginSyncActivity();
    try {
      await this.sendToPeer(peer, frame);
      // Arquivos são transmitidos em segundo plano para não atrasar respostas
      // de sync, presença e novos frames na fila do processo principal.
      void this.messageService.replayPendingFilesForPeer(peer).catch(() => undefined);
      this.requestMissingDirectAttachmentsForPeer(peer);
    } catch (error) {
      if (throwOnFail) {
        throw error;
      }
      // peer offline ou inacessível; próxima presença online tentará novamente
    } finally {
      this.endSyncActivity();
    }
  }

  private hasUsableLocalAttachment(message: DbMessage | undefined): boolean {
    if (!message?.filePath) return false;
    try {
      return fs.statSync(message.filePath).isFile();
    } catch {
      return false;
    }
  }

  private async requestMissingDirectAttachment(message: DbMessage, preferredPeer?: Peer): Promise<void> {
    if (this.authState?.authenticated && this.relay?.isConnected() && message.fileId) {
      await this.downloadCanonicalAttachment(message).catch(() => undefined);
      return;
    }
    if (
      message.type !== 'file' ||
      message.direction !== 'in' ||
      message.deletedAt ||
      !message.fileId ||
      !message.senderDeviceId ||
      message.senderDeviceId === this.profile.deviceId ||
      this.hasUsableLocalAttachment(message)
    ) {
      return;
    }

    const peer =
      preferredPeer && preferredPeer.deviceId === message.senderDeviceId
        ? preferredPeer
        : this.presence.getPeer(message.senderDeviceId) || this.resolvePeerForTransport(message.senderDeviceId);
    if (!peer) return;

    const requestKey = message.messageId;
    const now = Date.now();
    const lastRequestAt = this.directFileRequestAtByMessageId.get(requestKey) || 0;
    if (
      this.directFileRequestInFlight.has(requestKey) ||
      now - lastRequestAt < this.directFileRequestMinIntervalMs
    ) {
      return;
    }

    this.directFileRequestAtByMessageId.set(requestKey, now);
    this.directFileRequestInFlight.add(requestKey);
    try {
      const waiting = this.db.markIncomingFileForRetry(message.messageId);
      if (waiting) {
        this.emitEvent({ type: 'message:updated', message: waiting });
      }
      await this.sendToPeer(peer, {
        type: 'file:request',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: message.senderDeviceId,
        createdAt: now,
        payload: {
          targetMessageId: message.messageId,
          fileId: message.fileId
        } satisfies FileRequestPayload
      });
    } catch {
      // O próximo snapshot de presença ou sync tentará novamente.
    } finally {
      this.directFileRequestInFlight.delete(requestKey);
    }
  }

  private async downloadCanonicalAttachment(message: DbMessage): Promise<void> {
    if (!this.relay || !message.fileId || !message.fileName || !message.fileSize || !message.fileSha256) {
      throw new Error('Metadados do anexo incompletos.');
    }
    if (this.hasUsableLocalAttachment(message) || this.directFileRequestInFlight.has(message.messageId)) return;
    this.directFileRequestInFlight.add(message.messageId);
    const offer: FileOfferPayload = {
      fileId: message.fileId,
      messageId: message.messageId,
      filename: message.fileName,
      size: message.fileSize,
      sha256: message.fileSha256
    };
    try {
      this.fileTransfer.startIncoming(offer, message.senderDeviceId);
      this.emitEvent({
        type: 'transfer:progress', direction: 'receive', fileId: message.fileId,
        messageId: message.messageId, peerId: message.senderDeviceId,
        transferred: 0, total: message.fileSize, stage: 'downloading'
      });
      await this.relay.downloadCentralAttachment(message.fileId, {
        onStart: () => undefined,
        onChunk: (chunk) => {
          const progress = this.fileTransfer.onChunk(chunk);
          this.emitEvent({
            type: 'transfer:progress', direction: 'receive', fileId: message.fileId!,
            messageId: message.messageId, peerId: message.senderDeviceId,
            transferred: progress.transferred, total: progress.total, stage: 'downloading'
          });
        }
      });
      await this.finalizeIncomingFileTransfer(message.fileId, message.senderDeviceId);
    } finally {
      this.directFileRequestInFlight.delete(message.messageId);
    }
  }

  private requestMissingDirectAttachmentsForPeer(peer: Peer): void {
    // Limita a recuperação inicial para não abrir dezenas de streams grandes
    // quando um dispositivo volta depois de muito tempo offline.
    for (const message of this.db.getIncomingFileMessagesForPeer(peer.deviceId, 20)) {
      if (!this.hasUsableLocalAttachment(message)) {
        void this.requestMissingDirectAttachment(message, peer);
      }
    }
  }

  private enqueueIncomingFrame(frame: ProtocolFrame): void {
    const task = this.incomingFrameQueue.then(() => this.handleIncomingFrame(frame));
    this.incomingFrameQueue = task.catch(() => undefined);
    void task.catch((error) => {
      if (process.env.LANTERN_DEBUG_DISCOVERY === '1') {
        console.warn(
          '[Lantern][Relay] falha ao processar frame recebido:',
          JSON.stringify({
            type: frame.type,
            messageId: frame.messageId,
            from: frame.from,
            to: frame.to,
            error: error instanceof Error ? error.message : String(error)
          })
        );
      }
    });
  }

  private async resyncConversation(conversationId: string): Promise<void> {
    const groupId = this.groupIdFromConversationId(conversationId);
    if (groupId) {
      if (!this.relay?.isConnected()) {
        throw new Error('Relay offline.');
      }
      await this.relay.syncGroups({ [groupId]: 0 });
      this.emitEvent({
        type: 'ui:toast',
        level: 'success',
        message: 'Ressincronização do grupo solicitada ao Relay.'
      });
      return;
    }

    if (!conversationId.startsWith('dm:')) {
      throw new Error('Ressincronização disponível apenas para conversas diretas.');
    }

    const peerId = conversationId.slice(3).trim();
    if (!peerId) {
      throw new Error('Contato inválido para ressincronizar.');
    }

    const peer = this.resolvePeerForTransport(peerId);
    if (!peer) {
      throw new Error('Contato offline no relay.');
    }

    await this.requestSync(peer, {
      force: true,
      throwOnFail: true,
      since: 0,
      limit: 100_000,
      fullResync: true
    });

    this.emitEvent({
      type: 'ui:toast',
      level: 'success',
      message: 'Ressincronização iniciada. A conversa será alinhada nos dois clientes.'
    });
  }

  private async sendToPeer(peer: Peer, frame: ProtocolFrame): Promise<void> {
    if (!this.relay || !this.relay.isConnected()) {
      throw new Error('Relay offline.');
    }

    const targetDeviceId = frame.to;
    const result = await this.relay.sendFrame(frame);
    if (targetDeviceId && !result.deliveredTo.includes(targetDeviceId)) {
      // A confirmação do Relay significa que a operação durável já foi salva.
      // O destinatário não precisa estar conectado para mensagens, reações,
      // edições ou exclusões. Typing continua sendo apenas best-effort.
      if (frame.type === 'typing') return;
    }
  }

  private async sendBroadcast(frame: ProtocolFrame): Promise<string[]> {
    if (!this.relay || !this.relay.isConnected()) {
      throw new Error('Relay offline.');
    }
    const result = await this.relay.sendFrame({
      ...frame,
      to: null
    });
    return result.deliveredTo;
  }

  private normalizeInboundCreatedAt(rawCreatedAt: number): number {
    const now = Date.now();
    if (!Number.isFinite(rawCreatedAt) || rawCreatedAt <= 0) {
      return now;
    }
    const parsed = Math.trunc(rawCreatedAt);
    return parsed > now ? now : parsed;
  }

  private normalizeReplyPayload(
    value: MessageReplyPayload | null | undefined
  ): MessageReplyPayload | null {
    if (!value) return null;
    const messageId = (value.messageId || '').trim();
    const senderDeviceId = (value.senderDeviceId || '').trim();
    if (!messageId || !senderDeviceId) {
      return null;
    }
    if (value.type !== 'text' && value.type !== 'announcement' && value.type !== 'file') {
      return null;
    }
    const previewText = (value.previewText || '').trim();
    const fileName = (value.fileName || '').trim();
    return {
      messageId,
      senderDeviceId,
      type: value.type,
      previewText: previewText ? previewText.slice(0, 300) : null,
      fileName: fileName ? fileName.slice(0, 260) : null
    };
  }

  private applyQueuedReactionsForMessage(message: Pick<DbMessage, 'messageId' | 'type'>): void {
    const pendingReactions = this.db.consumePendingMessageReactions(message.messageId);
    if (pendingReactions.length === 0) {
      return;
    }

    let summary = null as ReturnType<DbService['setMessageReaction']> | null;
    for (const pending of pendingReactions) {
      summary = this.db.setMessageReaction(
        pending.messageId,
        pending.reactorDeviceId,
        pending.reaction,
        this.profile.deviceId,
        pending.updatedAt
      );
    }

    if (!summary) {
      return;
    }

    this.emitEvent({
      type: message.type === 'announcement' ? 'announcement:reactions' : 'message:reactions',
      messageId: message.messageId,
      summary
    });
  }

  private async sendDeliveredAckBestEffort(
    toDeviceId: string,
    ackMessageId: string,
    activePeer?: Peer
  ): Promise<void> {
    const ackPeer =
      activePeer && activePeer.deviceId === toDeviceId
        ? activePeer
        : this.presence.getPeer(toDeviceId) || this.resolvePeerForTransport(toDeviceId);
    if (!ackPeer) return;

    try {
      await this.sendToPeer(ackPeer, {
        type: 'chat:ack',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: toDeviceId,
        createdAt: Date.now(),
        payload: { ackMessageId, status: 'delivered' }
      } satisfies ProtocolFrame<AckPayload>);
    } catch {
      // ACK best-effort: a falta dele não deve interromper o fluxo principal.
    }
  }

  private emitConversationUnread(conversationId: string): void {
    this.emitEvent({
      type: 'conversation:unread',
      conversationId,
      unreadCount: this.db.getConversationUnreadCount(conversationId)
    });
  }

  private markConversationRead(conversationId: string): void {
    const readMessageIds = this.db.markConversationRead(conversationId);
    this.emitConversationUnread(conversationId);

    if (conversationId === ANNOUNCEMENTS_CONVERSATION_ID) {
      void this.markVisibleAnnouncementsRead().catch(() => undefined);
      return;
    }

    if (!conversationId.startsWith('dm:')) {
      return;
    }

    const peer = this.getPeerFromConversationId(conversationId);
    if (!peer) {
      return;
    }

    if (readMessageIds.length === 0) {
      return;
    }

    for (const messageId of readMessageIds) {
      void this.sendToPeer(peer, {
        type: 'chat:ack',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: peer.deviceId,
        createdAt: Date.now(),
        payload: {
          ackMessageId: messageId,
          status: 'read'
        }
      } satisfies ProtocolFrame<AckPayload>).catch(() => undefined);
    }
  }

  private async markVisibleAnnouncementsRead(): Promise<void> {
    const messageIds = this.db.getActiveAnnouncementMessageIds();
    if (messageIds.length === 0) return;
    const readAt = Date.now();
    const touched = this.db.markAnnouncementRead(messageIds, this.profile.deviceId, readAt);
    const summaryByMessage = this.db.getAnnouncementReadSummary(touched, this.profile.deviceId);
    for (const messageId of touched) {
      this.emitEvent({
        type: 'announcement:reads',
        messageId,
        summary: summaryByMessage[messageId] || { count: 0, readByMe: false }
      });
    }
    await this.relay?.markAnnouncementsRead(touched, readAt).catch(() => undefined);
  }

  private markConversationUnread(conversationId: string): void {
    this.db.markConversationUnread(conversationId);
    this.emitConversationUnread(conversationId);
  }

  private bumpUnreadIfBackground(conversationId: string, messageCreatedAt?: number): void {
    const isVisibleFocused =
      Boolean(this.mainWindow) &&
      this.mainWindow!.isVisible() &&
      !this.mainWindow!.isMinimized() &&
      this.mainWindow!.isFocused();

    if (this.activeConversationId === conversationId && isVisibleFocused) {
      this.markConversationRead(conversationId);
      return;
    }
    const before = this.db.getConversationUnreadCount(conversationId);
    const after = this.db.incrementUnread(conversationId, messageCreatedAt);
    if (after !== before) {
      this.emitConversationUnread(conversationId);
    }
  }

  private notifyIncomingIfNeeded(
    message: Pick<
      DbMessage,
      'messageId' | 'type' | 'bodyText' | 'conversationId' | 'senderDeviceId' | 'createdAt' | 'fileName'
    >,
    source: 'live' | 'sync',
    sender?: Pick<Peer, 'displayName' | 'avatarEmoji' | 'avatarBg'>
  ): void {
    if (!this.notifications.shouldNotify()) {
      return;
    }
    if (
      source === 'sync' &&
      Date.now() - message.createdAt > this.syncNotificationMaxAgeMs
    ) {
      return;
    }

    if (message.type === 'announcement') {
      this.notifications.notifyAnnouncement(message.bodyText || 'Novo anúncio', sender
        ? {
            emoji: sender.avatarEmoji,
            bg: sender.avatarBg
          }
        : undefined,
        message.messageId,
        message.createdAt);
      return;
    }

    if (message.type === 'text') {
      this.notifications.notifyMessage(
        sender?.displayName || 'Nova mensagem',
        message.bodyText || 'Nova mensagem',
        message.conversationId,
        sender
          ? {
              emoji: sender.avatarEmoji,
              bg: sender.avatarBg
            }
          : undefined,
        message.messageId,
        message.createdAt
      );
      return;
    }

    if (message.type === 'file') {
      const fileLabel = (message.fileName || '').trim() || 'arquivo';
      this.notifications.notifyMessage(
        sender?.displayName || 'Novo anexo',
        `Enviou um arquivo: ${fileLabel}`,
        message.conversationId,
        sender
          ? {
              emoji: sender.avatarEmoji,
              bg: sender.avatarBg
            }
          : undefined,
        message.messageId,
        message.createdAt
      );
    }
  }

  private replaceIncomingNotificationIfTracked(
    message: DbMessage,
    sender?: Pick<Peer, 'displayName' | 'avatarEmoji' | 'avatarBg'>
  ): void {
    if (message.direction !== 'in' || message.deletedAt) {
      return;
    }
    if (message.type !== 'text' && message.type !== 'announcement') {
      return;
    }
    const senderName =
      message.type === 'announcement'
        ? '📢 Anúncio editado'
        : sender?.displayName || 'Mensagem editada';
    const preview =
      message.type === 'announcement'
        ? message.bodyText || 'Anúncio editado'
        : `Editou: ${message.bodyText || 'Mensagem'}`;
    this.notifications.replaceMessageNotification(
      message.messageId,
      senderName,
      preview,
      message.conversationId,
      sender
        ? {
            emoji: sender.avatarEmoji,
            bg: sender.avatarBg
          }
        : undefined,
      message.editedAt || Date.now()
    );
  }

  private beginSyncActivity(): void {
    if (this.syncIdleTimer) {
      clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = null;
    }
    const wasActive = this.syncActivityCount > 0;
    this.syncActivityCount += 1;
    if (!wasActive) {
      this.emitEvent({ type: 'sync:status', active: true });
    }
  }

  private endSyncActivity(): void {
    if (this.syncActivityCount <= 0) {
      this.syncActivityCount = 0;
      return;
    }
    this.syncActivityCount -= 1;
    if (this.syncActivityCount > 0) {
      return;
    }
    if (this.syncIdleTimer) {
      clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = null;
    }
    this.syncIdleTimer = setTimeout(() => {
      this.syncIdleTimer = null;
      if (this.syncActivityCount === 0) {
        this.emitEvent({ type: 'sync:status', active: false });
      }
    }, this.syncIdleGraceMs);
    this.syncIdleTimer.unref?.();
  }

  private dropPeerRuntimeState(peerId: string): boolean {
    this.syncRequestAtByPeer.delete(peerId);
    this.knownOnlinePeerIds.delete(peerId);
    this.peerUnreachableFailures.delete(peerId);
    return this.presence.markPeerOffline(peerId);
  }

  private enqueuePendingPeerOperationIfMissing(
    peerId: string,
    type: 'chat:clear' | 'chat:forget'
  ): void {
    const cleanPeerId = (peerId || '').trim();
    if (!cleanPeerId) return;
    const exists = this.db
      .getPendingPeerOperations(cleanPeerId)
      .some((row) => row.type === type);
    if (exists) return;
    this.db.enqueuePendingPeerOperation(cleanPeerId, type, { scope: 'dm' });
  }

  private enqueuePendingReactionOperation(
    peerId: string,
    targetMessageId: string,
    reaction: ReactPayload['reaction']
  ): void {
    const cleanPeerId = (peerId || '').trim();
    const cleanTargetMessageId = (targetMessageId || '').trim();
    if (!cleanPeerId || !cleanTargetMessageId) return;
    this.db.enqueuePendingPeerOperation(cleanPeerId, 'chat:react', {
      targetMessageId: cleanTargetMessageId,
      reaction
    });
  }

  private async flushPendingPeerOperations(peerId: string, peerOverride?: Peer): Promise<void> {
    const cleanPeerId = (peerId || '').trim();
    if (!cleanPeerId) return;
    if (!this.relay || !this.relay.isConnected()) return;

    const peer = peerOverride || this.resolvePeerForTransport(cleanPeerId);
    if (!peer) return;

    const pending = this.db.getPendingPeerOperations(cleanPeerId);
    if (pending.length === 0) return;

    for (const operation of pending) {
      if (operation.nextAttemptAt > Date.now()) {
        break;
      }
      let frame: ProtocolFrame;
      if (operation.type === 'chat:clear' && 'scope' in operation.payload) {
        frame = {
          type: 'chat:clear',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: cleanPeerId,
          createdAt: Date.now(),
          payload: { scope: operation.payload.scope }
        } satisfies ProtocolFrame<ClearConversationPayload>;
      } else if (operation.type === 'chat:react' && 'targetMessageId' in operation.payload) {
        frame = {
          type: 'chat:react',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: cleanPeerId,
          createdAt: operation.createdAt,
          payload: {
            targetMessageId: operation.payload.targetMessageId,
            reaction: operation.payload.reaction
          }
        } satisfies ProtocolFrame<ReactPayload>;
      } else if (operation.type === 'chat:forget' && 'scope' in operation.payload) {
        frame = {
          type: 'chat:forget',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: cleanPeerId,
          createdAt: Date.now(),
          payload: { scope: operation.payload.scope }
        } satisfies ProtocolFrame<ForgetPeerPayload>;
      } else {
        this.db.removePendingPeerOperation(operation.id);
        continue;
      }
      try {
        await this.sendToPeer(peer, frame);
        this.db.removePendingPeerOperation(operation.id);
      } catch (error) {
        this.db.markPendingPeerOperationFailed(
          operation.id,
          error instanceof Error ? error.message : String(error)
        );
        break;
      }
    }
  }

  private forgetPeerLocally(peerId: string): void {
    const now = Date.now();
    this.forgottenPeersById.set(peerId, {
      waitingForOffline: true,
      updatedAt: now
    });
    this.db.removePeerCache(peerId);
    this.peersById.delete(peerId);
    this.dropPeerRuntimeState(peerId);
  }

  private markPeerUnreachable(
    peerId: string,
    options?: { force?: boolean }
  ): void {
    const peer = this.presence.getPeer(peerId) || this.peersById.get(peerId);
    if (!peer) return;

    const force = Boolean(options?.force);
    if (!force) return;

    const now = Date.now();
    const previous = this.peerUnreachableFailures.get(peerId);
    const count =
      previous && now - previous.lastAt <= this.peerUnreachableFailureWindowMs
        ? previous.count + 1
        : 1;
    this.peerUnreachableFailures.set(peerId, {
      count,
      lastAt: now
    });
    if (count < this.peerUnreachableFailureThreshold) {
      return;
    }
    this.peerUnreachableFailures.delete(peerId);

    const changed = this.dropPeerRuntimeState(peerId);
    if (changed) {
      this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
    }
  }

  private async sendTyping(peerId: string, isTyping: boolean): Promise<void> {
    const peer = this.resolvePeerForTransport(peerId);
    if (!peer) return;
    const frame: ProtocolFrame<TypingPayload> = {
      type: 'typing',
      messageId: randomUUID(),
      from: this.profile.deviceId,
      to: peer.deviceId,
      createdAt: Date.now(),
      payload: { isTyping }
    };
    try {
      await this.sendToPeer(peer, frame);
    } catch {
      // ignora falhas de typing em peers offline
    }
  }

  private async forwardMessageToPeer(
    targetPeerId: string,
    sourceMessageId: string
  ): Promise<DbMessage> {
    const cleanTargetPeerId = (targetPeerId || '').trim();
    const cleanSourceMessageId = (sourceMessageId || '').trim();
    if (!cleanTargetPeerId) {
      throw new Error('Contato de destino inválido para encaminhar.');
    }
    if (!cleanSourceMessageId) {
      throw new Error('Mensagem de origem inválida para encaminhar.');
    }
    if (cleanTargetPeerId === this.profile.deviceId) {
      throw new Error('Não é possível encaminhar para você mesmo.');
    }

    // getMessagesByIds hidrata caminhos de anexos de grupo concluídos que
    // podem ainda não estar gravados no registro bruto de messages.
    const source =
      this.db.getMessagesByIds([cleanSourceMessageId])[0] ||
      this.db.getMessageById(cleanSourceMessageId);
    if (!source || source.deletedAt) {
      throw new Error('Mensagem de origem não encontrada.');
    }

    const destinationPeer = this.resolvePeerForTransport(cleanTargetPeerId);
    if (!destinationPeer && !this.peersById.has(cleanTargetPeerId)) {
      throw new Error('Contato de destino não encontrado.');
    }

    if (source.type === 'file') {
      if (!this.hasUsableLocalAttachment(source)) {
        const groupId = this.groupIdFromConversationId(source.conversationId);
        if (groupId && source.fileId && source.senderDeviceId !== this.profile.deviceId) {
          void this.requestGroupAttachmentIfNeeded({
            fileId: source.fileId,
            groupId,
            messageId: source.messageId,
            senderDeviceId: source.senderDeviceId
          }).catch(() => undefined);
          throw new Error('Este anexo ainda está sendo baixado do Relay. Tente novamente em instantes.');
        }
        if (source.direction === 'in' && source.conversationId.startsWith('dm:')) {
          void this.requestMissingDirectAttachment(source);
          throw new Error('Este anexo ainda está sendo recebido. Tente novamente em instantes.');
        }
        throw new Error('Este anexo não está mais disponível neste dispositivo.');
      }
      const sourceFilePath = source.filePath!;
      return this.messageService.sendFile(cleanTargetPeerId, sourceFilePath, undefined, {
        forwardedFromMessageId: source.messageId
      });
    }

    const textToForward = (source.bodyText || '').trim();
    if (!textToForward) {
      throw new Error('Esta mensagem não possui conteúdo para encaminhar.');
    }
    return this.messageService.sendText(cleanTargetPeerId, textToForward, undefined, {
      forwardedFromMessageId: source.messageId
    });
  }

  private async reactToMessage(
    conversationId: string,
    messageId: string,
    reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null
  ): Promise<DbMessage | null> {
    const targetMessage = this.db.getMessageById(messageId);
    if (!targetMessage) return null;
    const reactionUpdatedAt = Date.now();

    const groupId = this.groupIdFromConversationId(conversationId);
    if (groupId) {
      const summary = this.db.setMessageReaction(
        messageId,
        this.profile.deviceId,
        reaction,
        this.profile.deviceId,
        reactionUpdatedAt
      );
      this.emitEvent({ type: 'message:reactions', messageId, summary });
      try {
        await this.relay?.sendGroupAction('react', {
          groupId,
          targetMessageId: messageId,
          reaction,
          updatedAt: reactionUpdatedAt
        });
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message: 'Relay offline. Reação do grupo não enviada.'
        });
      }
      return targetMessage;
    }

    const isAnnouncementConversation =
      conversationId === ANNOUNCEMENTS_CONVERSATION_ID || targetMessage.type === 'announcement';
    const summary = this.db.setMessageReaction(
      messageId,
      this.profile.deviceId,
      reaction,
      this.profile.deviceId,
      reactionUpdatedAt
    );
    this.emitEvent({
      type: isAnnouncementConversation ? 'announcement:reactions' : 'message:reactions',
      messageId,
      summary
    });

    if (conversationId.startsWith('dm:')) {
      const peerId = conversationId.slice(3).trim();
      if (!peerId) return targetMessage;
      const peer = this.getPeerFromConversationId(conversationId);
      if (!peer) {
        this.enqueuePendingReactionOperation(peerId, messageId, reaction);
        this.emitEvent({
          type: 'ui:toast',
          level: 'info',
          message: 'Contato offline. A reação será sincronizada quando ele voltar.'
        });
        return targetMessage;
      }
      const frame: ProtocolFrame<ReactPayload> = {
        type: 'chat:react',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: peer.deviceId,
        createdAt: reactionUpdatedAt,
        payload: {
          targetMessageId: messageId,
          reaction
        }
      };
      try {
        await this.sendToPeer(peer, frame);
        this.db.removePendingReactionOperation(peer.deviceId, messageId);
      } catch {
        this.enqueuePendingReactionOperation(peer.deviceId, messageId, reaction);
        this.emitEvent({
          type: 'ui:toast',
          level: 'info',
          message: 'Contato offline. A reação será sincronizada quando ele voltar.'
        });
        return targetMessage;
      }
    } else if (conversationId === ANNOUNCEMENTS_CONVERSATION_ID) {
      try {
        await this.sendBroadcast({
          type: 'chat:react',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: null,
          createdAt: Date.now(),
          payload: {
            targetMessageId: messageId,
            reaction
          }
        } satisfies ProtocolFrame<ReactPayload>);
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message: 'Relay offline. Reação não enviada.'
        });
        return targetMessage;
      }
    }
    return targetMessage;
  }

  private toggleMessageFavorite(
    conversationId: string,
    messageId: string,
    favorite: boolean
  ): boolean {
    const existing = this.db.getMessageById(messageId);
    if (!existing || existing.deletedAt) {
      throw new Error('Mensagem não encontrada para favoritar.');
    }
    if (existing.conversationId !== conversationId) {
      throw new Error('Mensagem não pertence a esta conversa.');
    }

    const nextFavorite = this.db.setMessageFavorite(messageId, Boolean(favorite));
    this.emitEvent({
      type: 'message:favorite',
      conversationId: existing.conversationId,
      messageId: existing.messageId,
      favorite: nextFavorite
    });
    return nextFavorite;
  }

  private async editMessage(
    conversationId: string,
    messageId: string,
    text: string
  ): Promise<DbMessage | null> {
    const existing = this.db.getMessageById(messageId);
    if (!existing) return null;
    if (existing.conversationId !== conversationId) {
      throw new Error('Mensagem não pertence a esta conversa.');
    }
    if (existing.type !== 'text' && existing.type !== 'announcement') {
      throw new Error('Somente mensagens de texto podem ser editadas.');
    }
    if (existing.direction !== 'out' || existing.senderDeviceId !== this.profile.deviceId) {
      throw new Error('Somente mensagens enviadas por você podem ser editadas.');
    }
    if (existing.deletedAt) {
      throw new Error('Não é possível editar uma mensagem apagada.');
    }
    if (Date.now() - existing.createdAt > this.editWindowMs) {
      throw new Error('O prazo para editar esta mensagem terminou.');
    }

    const editedAt = Date.now();
    const normalizedText = text.trim();

    if (conversationId === ANNOUNCEMENTS_CONVERSATION_ID) {
      await this.sendBroadcast({
        type: 'chat:edit',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: null,
        createdAt: editedAt,
        payload: {
          targetMessageId: messageId,
          text: normalizedText,
          editedAt
        }
      } satisfies ProtocolFrame<EditMessagePayload>);

      const updatedAnnouncement = this.db.updateMessageText(messageId, normalizedText, editedAt);
      if (updatedAnnouncement) {
        this.emitEvent({ type: 'message:updated', message: updatedAnnouncement });
      }
      return updatedAnnouncement || null;
    }

    const updated = this.db.updateMessageText(messageId, normalizedText, editedAt);
    if (!updated) return null;

    this.emitEvent({ type: 'message:updated', message: updated });

    const groupId = this.groupIdFromConversationId(conversationId);
    if (groupId) {
      await this.relay?.sendGroupAction('editMessage', {
        groupId,
        targetMessageId: messageId,
        text: updated.bodyText || '',
        editedAt
      });
      return updated;
    }

    const peer = this.getPeerFromConversationId(conversationId);
    if (peer) {
      const frame: ProtocolFrame<EditMessagePayload> = {
        type: 'chat:edit',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: peer.deviceId,
        createdAt: editedAt,
        payload: {
          targetMessageId: messageId,
          text: updated.bodyText || '',
          editedAt
        }
      };
      try {
        await this.sendToPeer(peer, frame);
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'info',
          message: 'Contato offline. A edição será sincronizada quando ele voltar.'
        });
      }
    }

    return updated;
  }

  private deleteMessageForMe(conversationId: string, messageId: string): DbMessage | null {
    const existing = this.db.getMessageById(messageId);
    if (!existing) return null;
    if (existing.conversationId !== conversationId) {
      throw new Error('Mensagem não pertence a esta conversa.');
    }
    const hidden = this.db.hideMessageForMe(messageId);
    if (!hidden) return null;
    this.notifications.closeMessageNotification(messageId);
    this.emitEvent({
      type: 'message:removed',
      conversationId,
      messageId
    });
    return hidden;
  }

  private async exportConversation(
    conversationId: string,
    format: 'txt' | 'html'
  ): Promise<{ canceled: boolean; filePath: string | null }> {
    const normalizedFormat = format === 'html' ? 'html' : 'txt';
    const messages = this.db.getExportMessages(conversationId);
    const conversationName =
      conversationId === ANNOUNCEMENTS_CONVERSATION_ID
        ? 'Anuncios'
        : this.getPeerFromConversationId(conversationId)?.displayName ||
          this.db.getCachedPeerById(conversationId.replace(/^dm:/, ''))?.displayName ||
          'Conversa';
    const safeName = conversationName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'conversa';
    const defaultPath = path.join(
      app.getPath('documents'),
      `Lantern-${safeName}-${new Date().toISOString().slice(0, 10)}.${normalizedFormat}`
    );
    const saveDialogOptions = {
      title: normalizedFormat === 'html' ? 'Exportar conversa em HTML' : 'Exportar conversa em TXT',
      defaultPath,
      filters:
        normalizedFormat === 'html'
          ? [{ name: 'HTML', extensions: ['html'] }]
          : [{ name: 'Texto', extensions: ['txt'] }]
    };
    const result = this.mainWindow
      ? await dialog.showSaveDialog(this.mainWindow, saveDialogOptions)
      : await dialog.showSaveDialog(saveDialogOptions);
    if (result.canceled || !result.filePath) {
      return { canceled: true, filePath: null };
    }

    const content =
      normalizedFormat === 'html'
        ? this.renderConversationExportHtml(conversationName, messages)
        : this.renderConversationExportText(conversationName, messages);
    await fs.promises.writeFile(result.filePath, content, 'utf8');
    return { canceled: false, filePath: result.filePath };
  }

  private senderNameForExport(message: DbMessage): string {
    if (message.senderDeviceId === this.profile.deviceId) {
      return 'Você';
    }
    const peer = this.peersById.get(message.senderDeviceId) || this.db.getCachedPeerById(message.senderDeviceId);
    return peer?.displayName || `Contato ${message.senderDeviceId.slice(0, 6)}`;
  }

  private renderConversationExportText(title: string, messages: DbMessage[]): string {
    const lines = [`Lantern - ${title}`, `Exportado em ${new Date().toLocaleString('pt-BR')}`, ''];
    for (const message of messages) {
      const time = new Date(message.createdAt).toLocaleString('pt-BR');
      const sender = this.senderNameForExport(message);
      const edited = message.editedAt ? ' (editada)' : '';
      const body =
        message.type === 'file'
          ? `[arquivo] ${message.fileName || 'Arquivo'} (${message.fileSize || 0} bytes)`
          : message.bodyText || '';
      const reply = message.replyToPreviewText || message.replyToFileName
        ? ` | resposta a: ${message.replyToFileName || message.replyToPreviewText}`
        : '';
      lines.push(`[${time}] ${sender}${edited}${reply}: ${body}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private renderConversationExportHtml(title: string, messages: DbMessage[]): string {
    const rows = messages
      .map((message) => {
        const time = new Date(message.createdAt).toLocaleString('pt-BR');
        const sender = this.senderNameForExport(message);
        const body =
          message.type === 'file'
            ? `[arquivo] ${message.fileName || 'Arquivo'} (${message.fileSize || 0} bytes)`
            : message.bodyText || '';
        const reply = message.replyToPreviewText || message.replyToFileName
          ? `<div class="reply">Resposta a: ${this.escapeHtml(message.replyToFileName || message.replyToPreviewText || '')}</div>`
          : '';
        const edited = message.editedAt ? '<span class="edited">editada</span>' : '';
        return `<article class="msg ${message.direction}">
          <header><strong>${this.escapeHtml(sender)}</strong><time>${this.escapeHtml(time)}</time>${edited}</header>
          ${reply}
          <div class="body">${this.escapeHtml(body).replace(/\n/g, '<br>')}</div>
        </article>`;
      })
      .join('\n');
    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>${this.escapeHtml(title)} - Lantern</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f5f7fb;color:#1f2937;margin:0;padding:24px}
    main{max-width:920px;margin:0 auto}
    h1{font-size:22px;margin:0 0 4px}
    .meta{color:#667085;margin:0 0 18px}
    .msg{background:#fff;border:1px solid #d9e0ea;border-radius:14px;padding:10px 12px;margin:8px 0;box-shadow:0 2px 8px rgba(15,23,42,.04)}
    .msg.out{margin-left:72px;background:#eef3ff}
    .msg.in{margin-right:72px}
    header{display:flex;gap:8px;align-items:center;font-size:13px;color:#344054}
    time{color:#667085}
    .edited{font-size:11px;color:#667085}
    .reply{border-left:3px solid #5b6ee1;padding-left:8px;color:#667085;font-size:12px;margin:6px 0}
    .body{white-space:pre-wrap;line-height:1.42;margin-top:6px}
  </style>
</head>
<body>
  <main>
    <h1>${this.escapeHtml(title)}</h1>
    <p class="meta">Exportado pelo Lantern em ${this.escapeHtml(new Date().toLocaleString('pt-BR'))}</p>
    ${rows}
  </main>
</body>
</html>`;
  }

  private async deleteMessageForEveryone(
    conversationId: string,
    messageId: string
  ): Promise<DbMessage | null> {
    const existing = this.db.getMessageById(messageId);
    if (!existing) return null;
    if (
      existing.direction !== 'out' ||
      existing.senderDeviceId !== this.profile.deviceId
    ) {
      throw new Error('Somente mensagens enviadas por você podem ser apagadas para todos.');
    }

    if (existing.filePath) {
      this.removeManagedAttachment(existing.filePath);
    }

    // "sent/failed/null" ainda representam entrega pendente.
    // "read" é mais forte que delivered e deve propagar exclusão remota.
    const isPendingDelivery =
      existing.status === 'sent' || existing.status === 'failed' || existing.status === null;

    const updated = this.db.deleteMessageForEveryone(messageId);
    if (!updated) return null;
    this.notifications.closeMessageNotification(messageId);

    const groupId = this.groupIdFromConversationId(conversationId);
    if (groupId) {
      try {
        await this.relay?.sendGroupAction('deleteMessage', {
          groupId,
          targetMessageId: messageId,
          deletedAt: Date.now()
        });
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message: 'Relay offline. A exclusão do grupo será aplicada apenas localmente por enquanto.'
        });
      }
      this.emitEvent({
        type: 'message:removed',
        conversationId: updated.conversationId,
        messageId: updated.messageId
      });
      return updated;
    }

    const peerIdFromConversation = conversationId.startsWith('dm:')
      ? conversationId.slice(3)
      : null;
    const isPeerOnlineNow = peerIdFromConversation
      ? Boolean(this.presence.getPeer(peerIdFromConversation))
      : false;

    if (!isPendingDelivery || isPeerOnlineNow || conversationId === ANNOUNCEMENTS_CONVERSATION_ID) {
      try {
        if (conversationId === ANNOUNCEMENTS_CONVERSATION_ID) {
          await this.sendBroadcast({
            type: 'chat:delete',
            messageId: randomUUID(),
            from: this.profile.deviceId,
            to: null,
            createdAt: Date.now(),
            payload: {
              targetMessageId: messageId
            }
          } satisfies ProtocolFrame<DeletePayload>);
        } else {
          const peer = this.getPeerFromConversationId(conversationId);
          if (peer) {
            const frame: ProtocolFrame<DeletePayload> = {
              type: 'chat:delete',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: peer.deviceId,
              createdAt: Date.now(),
              payload: {
                targetMessageId: messageId
              }
            };
            await this.sendToPeer(peer, frame);
          }
        }
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message:
            'Contato offline no momento. A exclusão será sincronizada quando a conexão voltar.'
        });
      }
    }

    this.emitEvent({
      type: 'message:removed',
      conversationId: updated.conversationId,
      messageId: updated.messageId
    });
    return updated;
  }

  private async finalizeIncomingFileTransfer(
    fileId: string,
    senderDeviceId: string,
    activePeer?: Peer
  ): Promise<void> {
    let result: { ok: boolean; finalPath: string; messageId: string; peerId: string };
    try {
      result = await this.fileTransfer.finalize(fileId);
    } catch {
      const pending = this.db.getMessageByFileId(fileId);
      if (pending?.senderDeviceId === senderDeviceId) {
        void this.requestMissingDirectAttachment(pending, activePeer);
      }
      return;
    }

    this.db.updateFilePath(fileId, result.finalPath, result.ok ? 'delivered' : 'failed');
    const updated = this.db.getMessageById(result.messageId);
    if (updated) {
      this.emitEvent({
        type: 'message:updated',
        message: updated
      });
    }

    this.emitEvent({
      type: 'message:status',
      messageId: result.messageId,
      conversationId: updated?.conversationId || null,
      status: result.ok ? 'delivered' : 'failed'
    });
    if (!result.ok) {
      this.emitEvent({
        type: 'ui:toast',
        level: 'error',
        message: 'Falha na validação do anexo recebido. O remetente irá reenviar.'
      });
      if (updated?.senderDeviceId === senderDeviceId) {
        void this.requestMissingDirectAttachment(updated, activePeer);
      }
      return;
    }

    this.directFileRequestAtByMessageId.delete(result.messageId);

    const ackPeer =
      activePeer && activePeer.deviceId === senderDeviceId
        ? activePeer
        : this.presence.getPeer(senderDeviceId) || this.resolvePeerForTransport(senderDeviceId);
    if (!ackPeer) return;

    try {
      await this.sendToPeer(ackPeer, {
        type: 'chat:ack',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: senderDeviceId,
        createdAt: Date.now(),
        payload: { ackMessageId: result.messageId, status: 'delivered' }
      });
    } catch {
      // ACK best-effort: recebimento do arquivo já foi persistido localmente.
    }
  }

  private reconcileLegacyIncomingFilePaths(): void {
    const brokenRows = this.db.getIncomingFileMessagesWithoutPath(2000);
    if (brokenRows.length === 0) {
      return;
    }

    const attachmentsDir = path.resolve(this.fileTransfer.getAttachmentsDir());
    let cachedDirEntries: string[] | null = null;
    const readDirEntries = (): string[] => {
      if (cachedDirEntries) return cachedDirEntries;
      try {
        cachedDirEntries = fs.readdirSync(attachmentsDir);
      } catch {
        cachedDirEntries = [];
      }
      return cachedDirEntries;
    };

    let repaired = 0;
    for (const row of brokenRows) {
      if (!row.fileId) continue;
      const prefix = `${row.messageId}_`;
      let recoveredPath: string | null = null;

      if (row.fileName) {
        const directPath = path.join(attachmentsDir, prefix + row.fileName);
        if (fs.existsSync(directPath)) {
          recoveredPath = directPath;
        }
      }

      if (!recoveredPath) {
        const foundName = readDirEntries().find((entry) => entry.startsWith(prefix));
        if (foundName) {
          const candidate = path.join(attachmentsDir, foundName);
          if (fs.existsSync(candidate)) {
            recoveredPath = candidate;
          }
        }
      }

      if (!recoveredPath) {
        continue;
      }

      this.db.updateFilePath(row.fileId, recoveredPath, 'delivered');
      const updated = this.db.getMessageById(row.messageId);
      if (updated) {
        this.emitEvent({
          type: 'message:updated',
          message: updated
        });
        this.emitEvent({
          type: 'message:status',
          messageId: updated.messageId,
          conversationId: updated.conversationId,
          status: updated.status === 'read' ? 'read' : 'delivered'
        });
      }
      repaired += 1;
    }

    if (process.env.LANTERN_DEBUG_DISCOVERY === '1' && repaired > 0) {
      console.log(
        '[Lantern][Files] registros legados corrigidos',
        JSON.stringify({ repaired, scanned: brokenRows.length, attachmentsDir })
      );
    }
  }

  private async handleIncomingFrame(
    frame: ProtocolFrame,
    deliverySource: 'live' | 'sync' = 'live'
  ): Promise<void> {
    if (frame.from === this.profile.deviceId) {
      return;
    }

    const forgottenState = this.forgottenPeersById.get(frame.from);
    if (forgottenState?.waitingForOffline && frame.type !== 'announce') {
      return;
    }
    if (forgottenState && !forgottenState.waitingForOffline) {
      this.forgottenPeersById.delete(frame.from);
      this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
    }

    const peer = this.peersById.get(frame.from) || this.resolvePeerForTransport(frame.from);
    const transportPeer = this.buildTransportPeerFromFrame(frame, peer);
    const activePeer =
      this.presence.getPeer(frame.from) ||
      transportPeer ||
      peer ||
      ({
        deviceId: frame.from,
        displayName: `Contato ${frame.from.slice(0, 6)}`,
        avatarEmoji: '🙂',
        avatarBg: '#5b5fc7',
        statusMessage: 'Disponível',
        address: '',
        port: 0,
        appVersion: 'unknown',
        lastSeenAt: Date.now(),
        source: 'relay'
      } satisfies Peer);

    switch (frame.type) {
      case 'hello': {
        if (activePeer) {
          void this.requestSync(activePeer).catch(() => undefined);
          void this.messageService.retryFailedMessagesForPeer(activePeer).catch(() => undefined);
        }
        break;
      }
      case 'chat:text': {
        const payload = frame.payload as ChatTextPayload;
        const replyTo = this.normalizeReplyPayload(payload.replyTo);
        const forwardedFromMessageId =
          typeof payload.forwardedFromMessageId === 'string' &&
          payload.forwardedFromMessageId.trim().length > 0
            ? payload.forwardedFromMessageId.trim()
            : null;
        const conversationId = this.db.ensureDmConversation(frame.from, activePeer?.displayName || frame.from);
        const normalizedCreatedAt = this.normalizeInboundCreatedAt(frame.createdAt);
        const createdAt = this.db.reserveConversationTimestamp(
          conversationId,
          normalizedCreatedAt
        );
        const row: DbMessage = {
          messageId: frame.messageId,
          conversationId,
          direction: 'in',
          senderDeviceId: frame.from,
          receiverDeviceId: this.profile.deviceId,
          type: 'text',
          bodyText: payload.text,
          fileId: null,
          fileName: null,
          fileSize: null,
          fileSha256: null,
          filePath: null,
          status: 'delivered',
          reaction: null,
          deletedAt: null,
          replyToMessageId: replyTo?.messageId || null,
          replyToSenderDeviceId: replyTo?.senderDeviceId || null,
          replyToType: replyTo?.type || null,
          replyToPreviewText: replyTo?.previewText || null,
          replyToFileName: replyTo?.fileName || null,
          forwardedFromMessageId,
          editedAt: null,
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(conversationId, row.createdAt);
          this.emitEvent({ type: 'message:received', message: row });
          this.applyQueuedReactionsForMessage(row);
          this.notifyIncomingIfNeeded(
            row,
            deliverySource,
            activePeer
              ? {
                  displayName: activePeer.displayName || 'Nova mensagem',
                  avatarEmoji: activePeer.avatarEmoji,
                  avatarBg: activePeer.avatarBg
                }
              : undefined
          );
        }

        if (deliverySource === 'live' && activePeer) {
          try {
            await this.sendToPeer(activePeer, {
              type: 'chat:ack',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: frame.from,
              createdAt: Date.now(),
              payload: { ackMessageId: frame.messageId, status: 'delivered' }
            });
          } catch {
            // ACK best-effort: evita quebrar o fluxo da mensagem recebida.
          }
        }
        break;
      }
      case 'announce': {
        const payload = frame.payload as AnnouncementPayload;
        const replyTo = this.normalizeReplyPayload(payload.replyTo);
        const normalizedCreatedAt = this.normalizeInboundCreatedAt(frame.createdAt);
        const createdAt = this.db.reserveConversationTimestamp(
          ANNOUNCEMENTS_CONVERSATION_ID,
          normalizedCreatedAt
        );
        const row: DbMessage = {
          messageId: frame.messageId,
          conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
          direction: 'in',
          senderDeviceId: frame.from,
          receiverDeviceId: null,
          type: 'announcement',
          bodyText: payload.text,
          fileId: null,
          fileName: null,
          fileSize: null,
          fileSha256: null,
          filePath: null,
          status: 'delivered',
          reaction: null,
          deletedAt: null,
          replyToMessageId: replyTo?.messageId || null,
          replyToSenderDeviceId: replyTo?.senderDeviceId || null,
          replyToType: replyTo?.type || null,
          replyToPreviewText: replyTo?.previewText || null,
          replyToFileName: replyTo?.fileName || null,
          forwardedFromMessageId: null,
          editedAt:
            typeof payload.editedAt === 'number' && Number.isFinite(payload.editedAt)
              ? this.normalizeInboundCreatedAt(payload.editedAt)
              : null,
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(ANNOUNCEMENTS_CONVERSATION_ID, row.createdAt);
          this.emitEvent({ type: 'message:received', message: row });
          this.notifyIncomingIfNeeded(
            row,
            deliverySource,
            activePeer
              ? {
                  displayName: activePeer.displayName || 'Anúncio',
                  avatarEmoji: activePeer.avatarEmoji,
                  avatarBg: activePeer.avatarBg
                }
              : undefined
          );
        } else if (
          typeof payload.editedAt === 'number' &&
          Number.isFinite(payload.editedAt) &&
          this.db.getMessageById(frame.messageId)?.senderDeviceId === frame.from
        ) {
          const updated = this.db.updateMessageText(
            frame.messageId,
            payload.text,
            this.normalizeInboundCreatedAt(payload.editedAt)
          );
          if (updated) {
            this.emitEvent({ type: 'message:updated', message: updated });
          }
        }

        if (deliverySource === 'live' && activePeer) {
          try {
            await this.sendToPeer(activePeer, {
              type: 'chat:ack',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: frame.from,
              createdAt: Date.now(),
              payload: { ackMessageId: frame.messageId, status: 'delivered' }
            });
          } catch {
            // ACK best-effort: evita quebrar o fluxo do anúncio recebido.
          }
        }
        break;
      }
      case 'chat:ack': {
        const payload = frame.payload as AckPayload;
        this.db.updateMessageStatus(payload.ackMessageId, payload.status);
        const acked = this.db.getMessageById(payload.ackMessageId);
        this.emitEvent({
          type: 'message:status',
          messageId: payload.ackMessageId,
          conversationId: acked?.conversationId || null,
          status: payload.status
        });
        break;
      }
      case 'chat:react': {
        const payload = frame.payload as ReactPayload;
        const target = this.db.getMessageById(payload.targetMessageId);
        if (!target) {
          if (frame.to !== null) {
            this.db.upsertPendingMessageReaction(
              payload.targetMessageId,
              frame.from,
              payload.reaction,
              frame.createdAt
            );
            if (deliverySource === 'live' && activePeer) {
              void this.requestSync(activePeer, {
                force: true,
                since: 0,
                limit: 100_000,
                fullResync: true
              }).catch(() => undefined);
            }
          }
          break;
        }

        const isAnnouncementReaction = target.type === 'announcement';
        const summary = this.db.setMessageReaction(
          payload.targetMessageId,
          frame.from,
          payload.reaction,
          this.profile.deviceId,
          this.normalizeInboundCreatedAt(frame.createdAt)
        );
        this.emitEvent({
          type: isAnnouncementReaction ? 'announcement:reactions' : 'message:reactions',
          messageId: payload.targetMessageId,
          summary
        });

        if (
          deliverySource === 'live' &&
          payload.reaction &&
          target.senderDeviceId === this.profile.deviceId &&
          frame.from !== this.profile.deviceId
        ) {
          const conversationId = target.conversationId || `dm:${frame.from}`;
          if (this.notifications.shouldNotify()) {
            this.notifications.notifyReaction(
              activePeer?.displayName || 'Contato',
              payload.reaction,
              conversationId,
              activePeer
                ? {
                    emoji: activePeer.avatarEmoji,
                    bg: activePeer.avatarBg
                  }
                : undefined
            );
          }
        }
        break;
      }
      case 'chat:delete': {
        const payload = frame.payload as DeletePayload;
        const existing = this.db.getMessageById(payload.targetMessageId);
        if (existing?.filePath) {
          this.removeManagedAttachment(existing.filePath);
        }
        const updated = this.db.deleteMessageForEveryone(payload.targetMessageId);
        if (updated) {
          this.notifications.closeMessageNotification(updated.messageId);
          this.emitEvent({
            type: 'message:removed',
            conversationId: updated.conversationId,
            messageId: updated.messageId
          });
        } else if (deliverySource === 'live' && activePeer) {
          // Corrige corrida: delete pode chegar antes do payload original.
          void this.requestSync(activePeer, {
            force: true,
            since: 0,
            limit: 100_000,
            fullResync: true
          }).catch(() => undefined);
        }
        break;
      }
      case 'chat:edit': {
        const payload = frame.payload as EditMessagePayload;
        const targetMessageId = (payload.targetMessageId || '').trim();
        const text = (payload.text || '').trim();
        if (!targetMessageId || !text) {
          break;
        }
        const existing = this.db.getMessageById(targetMessageId);
        if (!existing) {
          if (deliverySource === 'live' && activePeer) {
            void this.requestSync(activePeer, {
              force: true,
              since: 0,
              limit: 100_000,
              fullResync: true
            }).catch(() => undefined);
          }
          break;
        }
        if (existing.senderDeviceId !== frame.from || existing.deletedAt || existing.type !== 'text') {
          break;
        }
        const editedAt = this.normalizeInboundCreatedAt(payload.editedAt || frame.createdAt);
        const updated = this.db.updateMessageText(targetMessageId, text, editedAt);
        if (updated) {
          this.emitEvent({ type: 'message:updated', message: updated });
          this.replaceIncomingNotificationIfTracked(updated, activePeer);
        }
        break;
      }
      case 'chat:clear': {
        const payload = frame.payload as ClearConversationPayload;
        if (payload.scope === 'dm') {
          const conversationId = `dm:${frame.from}`;
          this.clearConversationLocal(conversationId);
        }
        break;
      }
      case 'chat:forget': {
        const payload = frame.payload as ForgetPeerPayload;
        if (payload.scope === 'dm') {
          const conversationId = `dm:${frame.from}`;
          this.clearConversationLocal(conversationId);
          this.db.removeConversation(conversationId);
          this.forgetPeerLocally(frame.from);
          this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
        }
        break;
      }
      case 'chat:sync:request': {
        this.beginSyncActivity();
        try {
          const payload = frame.payload as SyncRequestPayload;
          const fullResyncRequested = Boolean(payload.fullResync);
          const requestedLimit = fullResyncRequested
            ? 100_000
            : Math.max(100, Math.min(payload.limit || 1000, 5000));
          const requestedSince = fullResyncRequested ? 0 : payload.since;
          const syncFrame: ProtocolFrame<SyncResponsePayload> = {
            type: 'chat:sync:response',
            messageId: randomUUID(),
            from: this.profile.deviceId,
            to: frame.from,
            createdAt: Date.now(),
            payload: {
              messages: this.syncService.buildSyncMessages(
                frame.from,
                requestedLimit,
                requestedSince
              )
            }
          };

          if (activePeer) {
            try {
              await this.sendToPeer(activePeer, syncFrame);
            } catch {
              // sync-response best-effort durante oscilação de presença.
            }
          }
          if (activePeer) {
            await this.messageService.retryFailedMessagesForPeer(activePeer);
            void this.messageService.replayPendingFilesForPeer(activePeer).catch(() => undefined);
            if (fullResyncRequested) {
              // Garante alinhamento bidirecional completo sem loop infinito.
              await this.requestSync(activePeer, {
                force: true,
                since: 0,
                limit: 100_000,
                fullResync: false
              });
            }
          }
        } finally {
          this.endSyncActivity();
        }
        break;
      }
      case 'chat:sync:response': {
        this.beginSyncActivity();
        try {
          const payload = frame.payload as SyncResponsePayload;
          const ackIds: string[] = [];

          for (const syncMessage of payload.messages || []) {
            const result = this.syncService.applySyncedMessage(syncMessage, this.peersById);
            if (!result.row) {
              continue;
            }

            if (result.row.deletedAt) {
              this.notifications.closeMessageNotification(result.row.messageId);
              this.emitEvent({
                type: 'message:removed',
                conversationId: result.row.conversationId,
                messageId: result.row.messageId
              });
              continue;
            }

            if (result.inserted) {
              if (result.row.direction === 'in') {
                this.bumpUnreadIfBackground(result.row.conversationId, result.row.createdAt);
                const syncSender =
                  this.peersById.get(result.row.senderDeviceId) ||
                  (activePeer && activePeer.deviceId === result.row.senderDeviceId
                    ? activePeer
                    : undefined);
                this.notifyIncomingIfNeeded(
                  result.row,
                  'sync',
                  syncSender
                    ? {
                        displayName: syncSender.displayName,
                        avatarEmoji: syncSender.avatarEmoji,
                        avatarBg: syncSender.avatarBg
                      }
                    : undefined
                );
              }
              this.emitEvent({ type: 'message:received', message: result.row });
              this.applyQueuedReactionsForMessage(result.row);
            } else {
              this.emitEvent({ type: 'message:updated', message: result.row });
              if (result.row.editedAt) {
                const syncSender =
                  this.peersById.get(result.row.senderDeviceId) ||
                  (activePeer && activePeer.deviceId === result.row.senderDeviceId
                    ? activePeer
                    : undefined);
                this.replaceIncomingNotificationIfTracked(result.row, syncSender);
              }
              this.applyQueuedReactionsForMessage(result.row);
            }

            if (
              result.row.direction === 'in' &&
              (result.row.type === 'text' || result.row.type === 'announcement')
            ) {
              ackIds.push(result.row.messageId);
            }
            if (
              result.row.direction === 'in' &&
              result.row.type === 'file' &&
              !this.hasUsableLocalAttachment(result.row)
            ) {
              void this.requestMissingDirectAttachment(result.row, activePeer);
            }
          }

          for (const ackMessageId of ackIds) {
            const ackFrame: ProtocolFrame<AckPayload> = {
              type: 'chat:ack',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: frame.from,
              createdAt: Date.now(),
              payload: {
                ackMessageId,
                status: 'delivered'
              }
            };
            if (activePeer) {
              try {
                await this.sendToPeer(activePeer, ackFrame);
              } catch {
                // ACK best-effort durante sync.
              }
            }
          }
        } finally {
          this.endSyncActivity();
        }
        break;
      }
      case 'typing': {
        const payload = frame.payload as TypingPayload;
        const conversationId = `dm:${frame.from}`;
        this.emitEvent({
          type: 'typing:update',
          conversationId,
          peerId: frame.from,
          isTyping: Boolean(payload.isTyping)
        });
        break;
      }
      case 'file:request': {
        const payload = frame.payload as FileRequestPayload;
        const targetMessageId = (payload.targetMessageId || '').trim();
        const requestedFileId = (payload.fileId || '').trim();
        if (!targetMessageId || !requestedFileId || !activePeer) {
          break;
        }
        const target = this.db.getMessageById(targetMessageId);
        if (
          !target ||
          target.type !== 'file' ||
          target.direction !== 'out' ||
          target.deletedAt ||
          target.senderDeviceId !== this.profile.deviceId ||
          target.receiverDeviceId !== frame.from ||
          target.fileId !== requestedFileId
        ) {
          break;
        }
        void this.messageService.resendFileMessageToPeer(activePeer, target).catch((error) => {
          if (process.env.LANTERN_DEBUG_DISCOVERY === '1') {
            console.warn(
              '[Lantern][Files] falha ao reenviar anexo solicitado:',
              error instanceof Error ? error.message : String(error)
            );
          }
        });
        break;
      }
      case 'file:offer': {
        const payload = frame.payload as FileOfferPayload;
        const replyTo = this.normalizeReplyPayload(payload.replyTo);
        const forwardedFromMessageId =
          typeof payload.forwardedFromMessageId === 'string' &&
          payload.forwardedFromMessageId.trim().length > 0
            ? payload.forwardedFromMessageId.trim()
            : null;
        const conversationId = this.db.ensureDmConversation(frame.from, activePeer?.displayName || frame.from);
        const normalizedCreatedAt = this.normalizeInboundCreatedAt(frame.createdAt);
        const createdAt = this.db.reserveConversationTimestamp(
          conversationId,
          normalizedCreatedAt
        );
        const existingMessage = this.db.getMessageById(payload.messageId);
        const existingFileComplete =
          existingMessage?.type === 'file' &&
          this.hasUsableLocalAttachment(existingMessage) &&
          (existingMessage.status === 'delivered' || existingMessage.status === 'read');
        const shouldReceiveFile =
          !existingFileComplete;

        if (shouldReceiveFile) {
          if (existingMessage) {
            const waiting = this.db.markIncomingFileForRetry(existingMessage.messageId);
            if (waiting) {
              this.emitEvent({ type: 'message:updated', message: waiting });
            }
          }
          this.fileTransfer.startIncoming(payload, frame.from);
          this.emitEvent({
            type: 'transfer:progress',
            direction: 'receive',
            fileId: payload.fileId,
            messageId: payload.messageId,
            peerId: frame.from,
            transferred: 0,
            total: payload.size
          });
        } else if (deliverySource === 'live') {
          await this.sendDeliveredAckBestEffort(frame.from, payload.messageId, activePeer);
        }

        const row: DbMessage = {
          messageId: payload.messageId,
          conversationId,
          direction: 'in',
          senderDeviceId: frame.from,
          receiverDeviceId: this.profile.deviceId,
          type: 'file',
          bodyText: null,
          fileId: payload.fileId,
          fileName: payload.filename,
          fileSize: payload.size,
          fileSha256: payload.sha256,
          filePath: null,
          status: 'sent',
          reaction: null,
          deletedAt: null,
          replyToMessageId: replyTo?.messageId || existingMessage?.replyToMessageId || null,
          replyToSenderDeviceId:
            replyTo?.senderDeviceId || existingMessage?.replyToSenderDeviceId || null,
          replyToType: replyTo?.type || existingMessage?.replyToType || null,
          replyToPreviewText:
            replyTo?.previewText || existingMessage?.replyToPreviewText || null,
          replyToFileName: replyTo?.fileName || existingMessage?.replyToFileName || null,
          forwardedFromMessageId:
            forwardedFromMessageId || existingMessage?.forwardedFromMessageId || null,
          editedAt: existingMessage?.editedAt || null,
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(conversationId, row.createdAt);
          this.emitEvent({ type: 'message:received', message: row });
          this.applyQueuedReactionsForMessage(row);
          this.notifyIncomingIfNeeded(
            row,
            deliverySource,
            activePeer
              ? {
                  displayName: activePeer.displayName || 'Novo anexo',
                  avatarEmoji: activePeer.avatarEmoji,
                  avatarBg: activePeer.avatarBg
                }
              : undefined
          );
        }

        const storedFile = this.db.getMessageById(payload.messageId);
        if (shouldReceiveFile && storedFile) {
          void this.downloadCanonicalAttachment(storedFile).catch((error) => {
            this.emitEvent({
              type: 'ui:toast', level: 'warning',
              message: error instanceof Error ? error.message : 'Não foi possível baixar o anexo do Relay.'
            });
          });
        }

        break;
      }
      case 'file:chunk': {
        const payload = frame.payload as FileChunkPayload;
        let progress: { done: boolean; transferred: number; total: number };
        try {
          progress = this.fileTransfer.onChunk(payload);
        } catch {
          const pending = this.db.getMessageByFileId(payload.fileId);
          if (pending?.senderDeviceId === frame.from) {
            void this.requestMissingDirectAttachment(pending, activePeer);
          }
          break;
        }
        this.emitEvent({
          type: 'transfer:progress',
          direction: 'receive',
          fileId: payload.fileId,
          messageId: '',
          peerId: frame.from,
          transferred: progress.transferred,
          total: progress.total
        });
        if (progress.done) {
          await this.finalizeIncomingFileTransfer(payload.fileId, frame.from, activePeer);
        }
        break;
      }
      case 'file:complete': {
        const payload = frame.payload as FileCompletePayload;
        await this.finalizeIncomingFileTransfer(payload.fileId, frame.from, activePeer);
        break;
      }
      default:
        break;
    }

  }

  private async applyCanonicalHistorySnapshot(frames: ProtocolFrame[]): Promise<void> {
    const ordered = [...frames].sort((left, right) =>
      left.createdAt !== right.createdAt
        ? left.createdAt - right.createdAt
        : left.messageId.localeCompare(right.messageId)
    );
    this.beginSyncActivity();
    try {
      for (const frame of ordered) {
        if (frame.from === this.profile.deviceId) {
          await this.applyOwnCanonicalFrame(frame);
        } else {
          await this.handleIncomingFrame(frame, 'sync');
        }
      }
    } finally {
      this.endSyncActivity();
    }
  }

  private async applyOwnCanonicalFrame(frame: ProtocolFrame): Promise<void> {
    if (frame.type === 'announce') return; // snapshot específico preserva expiração e leituras
    if (frame.type === 'chat:text' && frame.to) {
      const payload = frame.payload as ChatTextPayload;
      const replyTo = this.normalizeReplyPayload(payload.replyTo);
      const conversationId = this.db.ensureDmConversation(frame.to, this.peersById.get(frame.to)?.displayName || frame.to);
      const row: DbMessage = {
        messageId: frame.messageId, conversationId, direction: 'out',
        senderDeviceId: this.profile.deviceId, receiverDeviceId: frame.to, type: 'text',
        bodyText: payload.text, fileId: null, fileName: null, fileSize: null,
        fileSha256: null, filePath: null, status: 'delivered', reaction: null,
        deletedAt: null, replyToMessageId: replyTo?.messageId || null,
        replyToSenderDeviceId: replyTo?.senderDeviceId || null,
        replyToType: replyTo?.type || null, replyToPreviewText: replyTo?.previewText || null,
        replyToFileName: replyTo?.fileName || null,
        forwardedFromMessageId: payload.forwardedFromMessageId || null,
        editedAt: null, createdAt: frame.createdAt
      };
      const inserted = this.db.saveMessage(row);
      this.emitEvent({ type: inserted ? 'message:received' : 'message:updated', message: this.db.getMessageById(frame.messageId) || row });
      return;
    }
    if (frame.type === 'file:offer' && frame.to) {
      const payload = frame.payload as FileOfferPayload;
      const replyTo = this.normalizeReplyPayload(payload.replyTo);
      const conversationId = this.db.ensureDmConversation(frame.to, this.peersById.get(frame.to)?.displayName || frame.to);
      const row: DbMessage = {
        messageId: frame.messageId, conversationId, direction: 'out',
        senderDeviceId: this.profile.deviceId, receiverDeviceId: frame.to, type: 'file',
        bodyText: null, fileId: payload.fileId, fileName: payload.filename,
        fileSize: payload.size, fileSha256: payload.sha256, filePath: null,
        status: 'delivered', reaction: null, deletedAt: null,
        replyToMessageId: replyTo?.messageId || null,
        replyToSenderDeviceId: replyTo?.senderDeviceId || null,
        replyToType: replyTo?.type || null, replyToPreviewText: replyTo?.previewText || null,
        replyToFileName: replyTo?.fileName || null,
        forwardedFromMessageId: payload.forwardedFromMessageId || null,
        editedAt: null, createdAt: frame.createdAt
      };
      const inserted = this.db.saveMessage(row);
      const stored = this.db.getMessageById(frame.messageId) || row;
      this.emitEvent({ type: inserted ? 'message:received' : 'message:updated', message: stored });
      if (!this.hasUsableLocalAttachment(stored)) void this.downloadCanonicalAttachment(stored).catch(() => undefined);
      return;
    }
    if (frame.type === 'chat:edit') {
      const payload = frame.payload as EditMessagePayload;
      const updated = this.db.updateMessageText(payload.targetMessageId, payload.text, payload.editedAt);
      if (updated) this.emitEvent({ type: 'message:updated', message: updated });
      return;
    }
    if (frame.type === 'chat:delete') {
      const payload = frame.payload as DeletePayload;
      const deleted = this.db.deleteMessageForEveryone(payload.targetMessageId, frame.createdAt);
      if (deleted) this.emitEvent({ type: 'message:removed', conversationId: deleted.conversationId, messageId: deleted.messageId });
      return;
    }
    if (frame.type === 'chat:react') {
      const payload = frame.payload as ReactPayload;
      const target = this.db.getMessageById(payload.targetMessageId);
      if (!target) return;
      const summary = this.db.setMessageReaction(
        payload.targetMessageId, this.profile.deviceId, payload.reaction,
        this.profile.deviceId, frame.createdAt
      );
      this.emitEvent({ type: 'message:reactions', messageId: payload.targetMessageId, summary });
      return;
    }
    if ((frame.type === 'chat:clear' || frame.type === 'chat:forget') && frame.to) {
      const conversationId = `dm:${frame.to}`;
      this.db.clearConversation(conversationId);
      this.emitEvent({ type: 'conversation:cleared', conversationId });
    }
  }

  private buildTransportPeerFromFrame(
    frame: ProtocolFrame,
    existing?: Peer,
    remoteAddress?: string
  ): Peer | null {
    if (!frame.from || frame.from === this.profile.deviceId) {
      return null;
    }

    const normalizedRemoteAddress = (() => {
      if (!remoteAddress) return '';
      const value = remoteAddress.replace(/^::ffff:/, '');
      if (value === '::1' || value.startsWith('127.')) return '';
      return value;
    })();

    if (frame.type === 'hello') {
      const payload = (frame.payload || {}) as Partial<{
        deviceId: string;
        displayName: string;
        avatarEmoji: string;
        avatarBg: string;
        statusMessage: string;
        appVersion: string;
        wsPort: number | string;
      }>;

      if (payload.deviceId && payload.deviceId !== frame.from) {
        return null;
      }

      const wsPortValue =
        typeof payload.wsPort === 'string' || typeof payload.wsPort === 'number'
          ? Number(payload.wsPort)
          : NaN;
      const resolvedPort =
        Number.isFinite(wsPortValue) && wsPortValue > 0
          ? wsPortValue
          : existing?.port || 0;

      return {
        deviceId: frame.from,
        displayName: payload.displayName || existing?.displayName || `Contato ${frame.from.slice(0, 6)}`,
        avatarEmoji: payload.avatarEmoji || existing?.avatarEmoji || '🙂',
        avatarBg: payload.avatarBg || existing?.avatarBg || '#5b5fc7',
        statusMessage: payload.statusMessage || existing?.statusMessage || 'Disponível',
        address: normalizedRemoteAddress || existing?.address || '',
        port: resolvedPort,
        appVersion: payload.appVersion || existing?.appVersion || 'unknown',
        lastSeenAt: Date.now(),
        source: 'relay'
      };
    }

    if (!existing) {
      if (!normalizedRemoteAddress) {
        return null;
      }
      return {
        deviceId: frame.from,
        displayName: `Contato ${frame.from.slice(0, 6)}`,
        avatarEmoji: '🙂',
        avatarBg: '#5b5fc7',
        statusMessage: 'Disponível',
        address: normalizedRemoteAddress || '',
        port: 0,
        appVersion: 'unknown',
        lastSeenAt: Date.now(),
        source: 'relay'
      };
    }

    return {
      ...existing,
      address: normalizedRemoteAddress || existing.address || '',
      lastSeenAt: Date.now(),
      source: 'relay'
    };
  }

  private cleanup(): void {
    if (this.syncIdleTimer) {
      clearTimeout(this.syncIdleTimer);
      this.syncIdleTimer = null;
    }
    this.syncActivityCount = 0;
    try {
      this.relay?.stop();
    } catch {
      // ignore
    }
    this.knownOnlinePeerIds.clear();
    this.syncRequestAtByPeer.clear();
    this.peerUnreachableFailures.clear();
    this.forgottenPeersById.clear();
    try {
      this.tray?.destroy();
    } catch {
      // ignore
    }
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }

  private clearConversationLocal(conversationId: string): void {
    const filePaths = this.db.clearConversation(conversationId);
    for (const filePath of filePaths) {
      this.removeManagedAttachment(filePath);
    }
    this.emitEvent({ type: 'conversation:cleared', conversationId });
  }

  private async clearConversation(conversationId: string): Promise<void> {
    this.clearConversationLocal(conversationId);

    if (!conversationId.startsWith('dm:')) {
      return;
    }

    const peer = this.getPeerFromConversationId(conversationId);
    if (!peer) {
      this.enqueuePendingPeerOperationIfMissing(conversationId.slice(3), 'chat:clear');
      this.emitEvent({
        type: 'ui:toast',
        level: 'warning',
        message: 'Conversa limpa localmente. Será sincronizada quando o contato voltar online.'
      });
      return;
    }

    try {
      await this.sendToPeer(peer, {
        type: 'chat:clear',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: peer.deviceId,
        createdAt: Date.now(),
        payload: {
          scope: 'dm'
        }
      } satisfies ProtocolFrame<ClearConversationPayload>);
    } catch {
      this.enqueuePendingPeerOperationIfMissing(conversationId.slice(3), 'chat:clear');
      this.emitEvent({
        type: 'ui:toast',
        level: 'warning',
        message: 'Conversa limpa localmente. Será sincronizada quando o contato voltar online.'
      });
    }
  }

  private async forgetContactConversation(conversationId: string): Promise<void> {
    if (!conversationId.startsWith('dm:')) {
      this.clearConversationLocal(conversationId);
      return;
    }

    const peerId = conversationId.slice(3);
    const peer = this.getPeerFromConversationId(conversationId);
    this.clearConversationLocal(conversationId);
    if (!peer) {
      this.enqueuePendingPeerOperationIfMissing(peerId, 'chat:forget');
      this.emitEvent({
        type: 'ui:toast',
        level: 'warning',
        message: 'Contato removido localmente. A remoção será sincronizada quando o contato voltar online.'
      });
    } else {
      try {
        await this.sendToPeer(peer, {
          type: 'chat:clear',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: peer.deviceId,
          createdAt: Date.now(),
          payload: {
            scope: 'dm'
          }
        } satisfies ProtocolFrame<ClearConversationPayload>);

        await this.sendToPeer(peer, {
          type: 'chat:forget',
          messageId: randomUUID(),
          from: this.profile.deviceId,
          to: peer.deviceId,
          createdAt: Date.now(),
          payload: {
            scope: 'dm'
          }
        } satisfies ProtocolFrame<ForgetPeerPayload>);
      } catch {
        this.enqueuePendingPeerOperationIfMissing(peerId, 'chat:forget');
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message: 'Contato removido localmente. A remoção será sincronizada quando o contato voltar online.'
        });
      }
    }

    this.db.removeConversation(conversationId);
    this.forgetPeerLocally(peerId);
    this.emitEvent({ type: 'peers:updated', peers: this.getVisibleOnlinePeers() });
  }

  private removeManagedAttachment(filePath: string): void {
    try {
      const resolved = path.resolve(filePath);
      const attachmentsRoot = path.resolve(this.fileTransfer.getAttachmentsDir());
      const relative = path.relative(attachmentsRoot, resolved);
      const insideManagedRoot =
        relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative);
      if (!insideManagedRoot) {
        return;
      }
      if (!fs.existsSync(resolved)) {
        return;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return;
      }
      fs.unlinkSync(resolved);
    } catch {
      // ignora falhas de remoção
    }
  }

  private isGroupMissingOnRelayError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /grupo não encontrado|group not found|not found|não é participante ativo|not an active participant/i.test(message);
  }

  private markGroupMissingOnRelay(groupId: string): void {
    this.db.markGroupMissingOnRelay(groupId, true);
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
    this.emitEvent({
      type: 'ui:toast',
      level: 'warning',
      message: 'Este grupo não existe mais no Relay. O envio foi bloqueado; você pode excluir a conversa localmente.'
    });
  }

  private deleteLocalGroup(groupId: string): void {
    const filePaths = this.db.deleteLocalGroup(groupId);
    for (const filePath of filePaths) {
      this.removeManagedAttachment(filePath);
    }
    const conversationId = this.groupConversationId(groupId);
    this.emitEvent({ type: 'conversation:cleared', conversationId });
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
  }

  private getVisibleGroups(): GroupInfo[] {
    return this.db.getGroups().filter((group) => {
      const member = this.db
        .getGroupMembers(group.groupId)
        .find((candidate) => candidate.deviceId === this.profile.deviceId);
      return member?.status === 'active';
    });
  }

  private groupConversationId(groupId: string): string {
    return `group:${groupId}`;
  }

  private groupIdFromConversationId(conversationId: string): string | null {
    if (!conversationId.startsWith('group:')) return null;
    const groupId = conversationId.slice(6).trim();
    return groupId || null;
  }

  private sanitizeGroupReply(
    replyTo?: MessageReplyPayload | null
  ): MessageReplyPayload | null {
    return this.normalizeReplyPayload(replyTo || null);
  }

  private async ensureManagedOutgoingFileCopy(filePath: string, messageId: string): Promise<string> {
    const resolvedSource = path.resolve(filePath);
    const sourceStat = await fs.promises.stat(resolvedSource);
    if (!sourceStat.isFile()) {
      throw new Error('Caminho inválido: não é arquivo.');
    }
    const attachmentsDir = this.fileTransfer.getAttachmentsDir();
    const resolvedAttachmentsDir = path.resolve(attachmentsDir);
    const relative = path.relative(resolvedAttachmentsDir, resolvedSource);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return resolvedSource;
    }
    await fs.promises.mkdir(resolvedAttachmentsDir, { recursive: true });
    const safeName = path
      .basename(resolvedSource)
      .split('')
      .map((character) => {
        const code = character.codePointAt(0) || 0;
        return code < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character;
      })
      .join('') || 'arquivo';
    const managedPath = path.join(resolvedAttachmentsDir, `${messageId}_${safeName}`);
    await fs.promises.copyFile(resolvedSource, managedPath);
    return managedPath;
  }

  private cleanupEphemeralOutgoingFile(filePath: string): void {
    const resolvedFile = path.resolve(filePath);
    const temporaryDirectories = ['lantern-paste', 'lantern-stickers'].map(
      (name) => path.resolve(os.tmpdir(), name) + path.sep
    );
    if (!temporaryDirectories.some((directory) => resolvedFile.startsWith(directory))) {
      return;
    }
    void fs.promises.unlink(resolvedFile).catch(() => undefined);
  }

  private getGroupSenderLabel(deviceId: string): string {
    if (deviceId === this.profile.deviceId) {
      return 'Você';
    }
    const peer = this.presence.getPeer(deviceId) || this.peersById.get(deviceId) || this.db.getCachedPeerById(deviceId);
    return peer?.displayName || `Contato ${deviceId.slice(0, 6)}`;
  }

  private applyGroupSnapshot(snapshot: GroupSnapshot): void {
    if (!snapshot?.group?.groupId) return;
    this.db.upsertGroup(snapshot.group);
    this.db.upsertGroupMembers(snapshot.group.groupId, snapshot.members || []);
    this.db.replaceGroupPinnedMessages(
      snapshot.group.groupId,
      snapshot.pinnedMessageIds || [],
      snapshot.group.createdByDeviceId || this.profile.deviceId,
      Date.now()
    );
    const events = [...(snapshot.events || [])].sort((a, b) => a.seq - b.seq || a.eventId.localeCompare(b.eventId));
    for (const event of events) {
      this.applyGroupEvent(event);
    }
  }

  private handleGroupSnapshots(snapshots: GroupSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.applyGroupSnapshot(snapshot);
    }
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
    for (const snapshot of snapshots) {
      if (!snapshot?.group?.groupId) continue;
      this.emitEvent({
        type: 'group:members',
        groupId: snapshot.group.groupId,
        members: this.db.getGroupMembers(snapshot.group.groupId)
      });
      this.emitEvent({
        type: 'group:pins',
        groupId: snapshot.group.groupId,
        messageIds: this.db.getGroupPinnedMessageIds(snapshot.group.groupId)
      });
    }
  }

  private handleGroupEvent(event: GroupEvent): void {
    this.applyGroupEvent(event);
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
  }

  private applyGroupEvent(event: GroupEvent): void {
    if (!event?.eventId || !event.groupId) return;
    const payload = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;

    if (event.type === 'group.created' || event.type === 'group.updated' || event.type === 'group.deleted') {
      const group = payload.group as GroupInfo | undefined;
      if (group?.groupId) {
        this.db.upsertGroup(group);
      }
      const members = Array.isArray(payload.members) ? (payload.members as GroupMember[]) : [];
      if (members.length > 0) {
        this.db.upsertGroupMembers(event.groupId, members);
        this.emitEvent({ type: 'group:members', groupId: event.groupId, members: this.db.getGroupMembers(event.groupId) });
      }
      const pinnedMessageIds = Array.isArray(payload.pinnedMessageIds)
        ? payload.pinnedMessageIds.filter((value): value is string => typeof value === 'string')
        : null;
      if (pinnedMessageIds) {
        this.db.replaceGroupPinnedMessages(event.groupId, pinnedMessageIds, event.actorDeviceId, event.createdAt);
        this.emitEvent({ type: 'group:pins', groupId: event.groupId, messageIds: pinnedMessageIds });
      }
      this.db.markGroupEventApplied(event);
      return;
    }

    if (!this.db.markGroupEventApplied(event)) {
      return;
    }

    if (event.type === 'group.member.added') {
      const group = payload.group as GroupInfo | undefined;
      if (group?.groupId) {
        this.db.upsertGroup(group);
      }
      const members = Array.isArray(payload.members) ? (payload.members as GroupMember[]) : [];
      this.db.upsertGroupMembers(event.groupId, members);
      this.emitEvent({ type: 'group:members', groupId: event.groupId, members: this.db.getGroupMembers(event.groupId) });
      const pinnedMessageIds = Array.isArray(payload.pinnedMessageIds)
        ? payload.pinnedMessageIds.filter((value): value is string => typeof value === 'string')
        : null;
      if (pinnedMessageIds) {
        this.db.replaceGroupPinnedMessages(event.groupId, pinnedMessageIds, event.actorDeviceId, event.createdAt);
        this.emitEvent({ type: 'group:pins', groupId: event.groupId, messageIds: pinnedMessageIds });
      }
      return;
    }

    if (event.type === 'group.member.roleChanged') {
      const members = Array.isArray(payload.members)
        ? (payload.members as GroupMember[])
        : payload.member && typeof payload.member === 'object'
        ? [payload.member as GroupMember]
        : [];
      if (members.length > 0) {
        this.db.upsertGroupMembers(event.groupId, members);
        this.emitEvent({
          type: 'group:members',
          groupId: event.groupId,
          members: this.db.getGroupMembers(event.groupId)
        });
      }
      return;
    }

    if (event.type === 'group.member.removed' || event.type === 'group.member.left') {
      const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : event.actorDeviceId;
      const current = this.db.getGroupMembers(event.groupId).find((member) => member.deviceId === deviceId);
      this.db.upsertGroupMembers(event.groupId, [
        {
          groupId: event.groupId,
          deviceId,
          role: current?.role || 'member',
          status: event.type === 'group.member.left' ? 'left' : 'removed',
          displayNameSnapshot: current?.displayNameSnapshot || null,
          avatarEmojiSnapshot: current?.avatarEmojiSnapshot || null,
          avatarBgSnapshot: current?.avatarBgSnapshot || null,
          joinedAt: current?.joinedAt || event.createdAt,
          updatedAt: event.createdAt
        }
      ]);
      this.emitEvent({ type: 'group:members', groupId: event.groupId, members: this.db.getGroupMembers(event.groupId) });
      return;
    }

    if (event.type === 'group.message.created') {
      this.applyGroupMessageCreated(event, payload);
      return;
    }

    if (event.type === 'group.message.edited') {
      const targetMessageId = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
      const text = typeof payload.text === 'string' ? payload.text : '';
      const editedAt = typeof payload.editedAt === 'number' ? payload.editedAt : event.createdAt;
      const updated = targetMessageId ? this.db.updateMessageText(targetMessageId, text, editedAt) : undefined;
      if (updated) {
        this.emitEvent({ type: 'message:updated', message: updated });
      }
      return;
    }

    if (event.type === 'group.message.deletedForEveryone') {
      const targetMessageId = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
      const updated = targetMessageId ? this.db.deleteMessageForEveryone(targetMessageId, event.createdAt) : undefined;
      if (updated) {
        this.emitEvent({
          type: 'message:removed',
          conversationId: updated.conversationId,
          messageId: updated.messageId
        });
      }
      return;
    }

    if (event.type === 'group.message.reactionChanged') {
      const targetMessageId = typeof payload.targetMessageId === 'string' ? payload.targetMessageId : '';
      const reaction = payload.reaction === null ||
        payload.reaction === '👍' ||
        payload.reaction === '👎' ||
        payload.reaction === '❤️' ||
        payload.reaction === '😢' ||
        payload.reaction === '😊' ||
        payload.reaction === '😂'
        ? payload.reaction
        : null;
      if (targetMessageId) {
        const updatedAt =
          typeof payload.updatedAt === 'number' && Number.isFinite(payload.updatedAt)
            ? Math.trunc(payload.updatedAt)
            : event.createdAt;
        const summary = this.db.setMessageReaction(
          targetMessageId,
          event.actorDeviceId,
          reaction,
          this.profile.deviceId,
          updatedAt
        );
        this.emitEvent({ type: 'message:reactions', messageId: targetMessageId, summary });
      }
      return;
    }

    if (event.type === 'group.message.pinned' || event.type === 'group.message.unpinned') {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
      const next = this.db.setGroupMessagePinned(
        event.groupId,
        messageId,
        event.type === 'group.message.pinned',
        event.actorDeviceId,
        event.createdAt
      );
      this.emitEvent({ type: 'group:pins', groupId: event.groupId, messageIds: next });
      return;
    }

    if (event.type === 'group.attachment.available') {
      const metadata = (payload.metadata && typeof payload.metadata === 'object'
        ? payload.metadata
        : null) as Record<string, unknown> | null;
      if (metadata) {
        this.requestGroupAttachmentIfNeeded(metadata).catch(() => undefined);
      }
    }
  }

  private applyGroupMessageCreated(event: GroupEvent, payload: Record<string, unknown>): void {
    const rawMessage = (payload.message && typeof payload.message === 'object'
      ? payload.message
      : null) as Record<string, unknown> | null;
    if (!rawMessage) return;
    const messageId = typeof rawMessage.messageId === 'string' ? rawMessage.messageId : '';
    if (!messageId) return;
    const group = this.db.getGroupById(event.groupId);
    const conversationId = this.db.ensureGroupConversation(event.groupId, group?.name || 'Grupo');
    const senderDeviceId =
      typeof rawMessage.senderDeviceId === 'string' ? rawMessage.senderDeviceId : event.actorDeviceId;
    const direction = senderDeviceId === this.profile.deviceId ? 'out' : 'in';
    const rawReply = this.normalizeReplyPayload(
      (rawMessage.replyTo || null) as MessageReplyPayload | null
    );
    const type = rawMessage.type === 'file' ? 'file' : 'text';
    const message: DbMessage = {
      messageId,
      conversationId,
      direction,
      senderDeviceId,
      receiverDeviceId: null,
      type,
      bodyText:
        type === 'text'
          ? typeof rawMessage.bodyText === 'string'
            ? rawMessage.bodyText
            : typeof rawMessage.text === 'string'
            ? rawMessage.text
            : ''
          : null,
      fileId: typeof rawMessage.fileId === 'string' ? rawMessage.fileId : null,
      fileName: typeof rawMessage.fileName === 'string' ? rawMessage.fileName : null,
      fileSize: typeof rawMessage.fileSize === 'number' ? rawMessage.fileSize : null,
      fileSha256: typeof rawMessage.fileSha256 === 'string' ? rawMessage.fileSha256 : null,
      filePath: null,
      status: direction === 'out' ? 'delivered' : 'delivered',
      reaction: null,
      deletedAt: null,
      replyToMessageId: rawReply?.messageId || null,
      replyToSenderDeviceId: rawReply?.senderDeviceId || null,
      replyToType: rawReply?.type || null,
      replyToPreviewText: rawReply?.previewText || null,
      replyToFileName: rawReply?.fileName || null,
      forwardedFromMessageId:
        typeof rawMessage.forwardedFromMessageId === 'string'
          ? rawMessage.forwardedFromMessageId
          : null,
      editedAt: null,
      createdAt:
        typeof rawMessage.createdAt === 'number' && Number.isFinite(rawMessage.createdAt)
          ? Math.trunc(rawMessage.createdAt)
          : event.createdAt
    };

    if (message.type === 'file' && message.fileId) {
      const downloaded = this.db.getGroupAttachmentDownload(message.fileId);
      if (
        downloaded?.status === 'complete' &&
        downloaded.localPath &&
        fs.existsSync(downloaded.localPath)
      ) {
        message.filePath = downloaded.localPath;
        message.status = 'delivered';
      }
    }

    const inserted = this.db.saveMessage(message);
    if (!inserted && direction === 'out') {
      this.db.updateMessageStatus(message.messageId, 'delivered');
    }
    const saved = this.db.getMessageById(message.messageId) || message;
    this.applyQueuedReactionsForMessage(saved);
    this.emitEvent({
      type: inserted ? 'message:received' : 'message:updated',
      message: saved
    });

    // Snapshots and event replays can carry a message already persisted locally.
    // Only a new insert represents an unread/notification-worthy arrival.
    if (direction === 'in' && inserted) {
      this.bumpUnreadIfBackground(conversationId, saved.createdAt);
      this.notifyIncomingIfNeeded(
        saved,
        'live',
        this.presence.getPeer(senderDeviceId) ||
          this.db.getCachedPeerById(senderDeviceId) || {
            displayName: this.getGroupSenderLabel(senderDeviceId),
            avatarEmoji: '👥',
            avatarBg: group?.avatarBg || '#147ad6'
          }
      );
    }

    const metadata = (payload.attachment && typeof payload.attachment === 'object'
      ? payload.attachment
      : null) as Record<string, unknown> | null;
    if (metadata) {
      this.requestGroupAttachmentIfNeeded(metadata).catch(() => undefined);
    }
  }

  private async requestGroupAttachmentIfNeeded(metadata: Record<string, unknown>): Promise<void> {
    const fileId = typeof metadata.fileId === 'string' ? metadata.fileId : '';
    const groupId = typeof metadata.groupId === 'string' ? metadata.groupId : '';
    const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : '';
    const senderDeviceId = typeof metadata.senderDeviceId === 'string' ? metadata.senderDeviceId : '';
    const totalBytes =
      typeof metadata.fileSize === 'number' && Number.isFinite(metadata.fileSize)
        ? Math.max(0, Math.trunc(metadata.fileSize))
        : 0;
    if (!fileId || !groupId || !messageId || senderDeviceId === this.profile.deviceId) {
      return;
    }
    const message = this.db.getMessageById(messageId);
    if (this.hasUsableLocalAttachment(message)) {
      this.clearGroupFileDownloadRetry(fileId);
      await this.relay?.markGroupFileReceived(fileId).catch(() => undefined);
      return;
    }

    // group.message.created e group.attachment.available chegam em sequência e
    // podem tentar baixar o mesmo arquivo. O marcador precisa existir antes do
    // primeiro await para eliminar essa corrida.
    const existingCompletion = this.groupFileDownloadCompletionByFileId.get(fileId);
    if (existingCompletion) {
      await existingCompletion.promise;
      return;
    }

    let resolveCompletion!: () => void;
    const completion = {
      promise: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
      resolve: () => resolveCompletion()
    };
    this.groupFileDownloadCompletionByFileId.set(fileId, completion);

    try {
      const previous = this.db.getGroupAttachmentDownload(fileId);
      let tempPath = previous?.tempPath || null;
      let receivedBytes = 0;
      let nextChunkIndex = 0;
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          const stat = fs.statSync(tempPath);
          const safeSize = totalBytes > 0 ? Math.min(stat.size, totalBytes) : stat.size;
          receivedBytes = Math.floor(safeSize / FILE_CHUNK_SIZE_BYTES) * FILE_CHUNK_SIZE_BYTES;
          nextChunkIndex = Math.floor(receivedBytes / FILE_CHUNK_SIZE_BYTES);
          if (stat.size !== receivedBytes) fs.truncateSync(tempPath, receivedBytes);
        } catch {
          tempPath = null;
          receivedBytes = 0;
          nextChunkIndex = 0;
        }
      }
      const retryCount = Math.max(0, previous?.retryCount || 0);
      if (message) {
        const waiting = this.db.markIncomingFileForRetry(message.messageId);
        if (waiting) {
          this.emitEvent({ type: 'message:updated', message: waiting });
        }
      }
      this.db.upsertGroupAttachmentDownload({
        fileId,
        groupId,
        messageId,
        status: retryCount > 0 ? 'retrying' : 'pending',
        localPath: null,
        tempPath,
        totalBytes,
        receivedBytes,
        nextChunkIndex,
        totalChunks: totalBytes > 0 ? Math.max(1, Math.ceil(totalBytes / FILE_CHUNK_SIZE_BYTES)) : 1,
        retryCount,
        lastError: previous?.lastError || null,
        lastAttemptAt: Date.now(),
        requestId: null,
        receivedAt: null,
        updatedAt: Date.now()
      });
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'receive',
        fileId,
        messageId,
        peerId: senderDeviceId,
        transferred: receivedBytes,
        total: totalBytes,
        stage: retryCount > 0 ? 'retrying' : 'pending',
        attempt: retryCount,
        detail: retryCount > 0 ? 'Baixando novamente' : 'Aguardando o Relay'
      });

      const requestId = await this.relay?.requestGroupFile(fileId, nextChunkIndex).catch(() => null);
      if (!requestId) {
        this.scheduleGroupFileDownloadRetry(
          { fileId, groupId, messageId, senderDeviceId },
          'Relay indisponível durante a solicitação.'
        );
        completion.resolve();
        await completion.promise;
        return;
      }

      this.groupFileDownloadRequestIdByFileId.set(fileId, requestId);
      this.groupFileDownloadByRequestId.set(requestId, {
        fileId,
        groupId,
        messageId,
        senderDeviceId
      });
      this.db.upsertGroupAttachmentDownload({
        fileId,
        groupId,
        messageId,
        status: 'downloading',
        localPath: null,
        tempPath,
        totalBytes,
        receivedBytes,
        nextChunkIndex,
        totalChunks: totalBytes > 0 ? Math.max(1, Math.ceil(totalBytes / FILE_CHUNK_SIZE_BYTES)) : 1,
        retryCount,
        lastError: null,
        lastAttemptAt: Date.now(),
        requestId,
        receivedAt: null,
        updatedAt: Date.now()
      });
      this.scheduleGroupFileDownloadTimeout(requestId);
      await completion.promise;
    } finally {
      if (this.groupFileDownloadCompletionByFileId.get(fileId) === completion) {
        this.groupFileDownloadCompletionByFileId.delete(fileId);
      }
    }
  }

  private markGroupFileDownloadFailed(
    fileId: string,
    groupId: string,
    messageId: string,
    reason = 'Não foi possível baixar o anexo.'
  ): void {
    const previous = this.db.getGroupAttachmentDownload(fileId);
    this.db.updateMessageStatus(messageId, 'failed');
    this.db.upsertGroupAttachmentDownload({
      fileId,
      groupId,
      messageId,
      status: 'failed',
      localPath: null,
      tempPath: null,
      totalBytes: previous?.totalBytes || 0,
      receivedBytes: 0,
      nextChunkIndex: 0,
      totalChunks: previous?.totalChunks || 0,
      retryCount: Math.max(this.groupFileDownloadMaxRetries, previous?.retryCount || 0),
      lastError: reason,
      lastAttemptAt: Date.now(),
      requestId: null,
      receivedAt: null,
      updatedAt: Date.now()
    });
    const failed = this.db.getMessageById(messageId);
    if (!failed) return;
    this.emitEvent({ type: 'message:updated', message: failed });
    this.emitEvent({
      type: 'message:status',
      messageId,
      conversationId: failed.conversationId,
      status: 'failed'
    });
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'receive',
      fileId,
      messageId,
      peerId: failed.senderDeviceId,
      transferred: 0,
      total: previous?.totalBytes || failed.fileSize || 0,
      stage: 'failed',
      attempt: Math.max(this.groupFileDownloadMaxRetries, previous?.retryCount || 0),
      detail: reason
    });
  }

  private scheduleGroupFileDownloadTimeout(requestId: string): void {
    const previous = this.groupFileDownloadTimeoutByRequestId.get(requestId);
    if (previous) clearTimeout(previous);
    const timeout = setTimeout(() => {
      this.failGroupFileDownload(requestId, 'Tempo esgotado ao iniciar download do anexo.');
    }, this.groupFileDownloadStartTimeoutMs);
    timeout.unref?.();
    this.groupFileDownloadTimeoutByRequestId.set(requestId, timeout);
  }

  private clearGroupFileDownloadTimeout(requestId: string): void {
    const timeout = this.groupFileDownloadTimeoutByRequestId.get(requestId);
    if (timeout) clearTimeout(timeout);
    this.groupFileDownloadTimeoutByRequestId.delete(requestId);
  }

  private finishGroupFileDownloadTracking(requestId: string): void {
    const download = this.groupFileDownloadByRequestId.get(requestId);
    this.clearGroupFileDownloadTimeout(requestId);
    this.groupFileDownloadByRequestId.delete(requestId);
    if (!download) return;
    if (this.groupFileDownloadRequestIdByFileId.get(download.fileId) === requestId) {
      this.groupFileDownloadRequestIdByFileId.delete(download.fileId);
    }
    this.groupFileDownloadCompletionByFileId.get(download.fileId)?.resolve();
  }

  private clearGroupFileDownloadRetry(fileId: string): void {
    const timer = this.groupFileDownloadRetryTimerByFileId.get(fileId);
    if (timer) clearTimeout(timer);
    this.groupFileDownloadRetryTimerByFileId.delete(fileId);
  }

  private isPermanentGroupFileDownloadError(reason: string): boolean {
    const normalizedReason = reason.toLowerCase();
    return (
      normalizedReason.includes('indisponível no relay') ||
      normalizedReason.includes('não encontrado') ||
      normalizedReason.includes('não é destinatário') ||
      normalizedReason.includes('não existe') ||
      normalizedReason.includes('sha-256') ||
      normalizedReason.includes('tamanho inválido')
    );
  }

  private scheduleGroupFileDownloadRetry(
    download: { fileId: string; groupId: string; messageId: string; senderDeviceId: string },
    reason: string
  ): void {
    if (this.isPermanentGroupFileDownloadError(reason)) {
      this.markGroupFileDownloadFailed(
        download.fileId,
        download.groupId,
        download.messageId,
        reason
      );
      return;
    }
    const previous = this.db.getGroupAttachmentDownload(download.fileId);
    const retryCount = Math.max(0, previous?.retryCount || 0) + 1;
    if (retryCount > this.groupFileDownloadMaxRetries) {
      this.markGroupFileDownloadFailed(
        download.fileId,
        download.groupId,
        download.messageId,
        reason
      );
      return;
    }
    this.db.upsertGroupAttachmentDownload({
      fileId: download.fileId,
      groupId: download.groupId,
      messageId: download.messageId,
      status: this.relay?.isConnected() ? 'retrying' : 'reconnecting',
      localPath: null,
      tempPath: previous?.tempPath || null,
      totalBytes: previous?.totalBytes || 0,
      receivedBytes: previous?.receivedBytes || 0,
      nextChunkIndex: previous?.nextChunkIndex || 0,
      totalChunks: previous?.totalChunks || 0,
      retryCount,
      lastError: reason,
      lastAttemptAt: Date.now(),
      requestId: null,
      receivedAt: null,
      updatedAt: Date.now()
    });
    const waiting = this.db.markIncomingFileForRetry(download.messageId);
    if (waiting) this.emitEvent({ type: 'message:updated', message: waiting });
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'receive',
      fileId: download.fileId,
      messageId: download.messageId,
      peerId: download.senderDeviceId,
      transferred: previous?.receivedBytes || 0,
      total: previous?.totalBytes || waiting?.fileSize || 0,
      stage: this.relay?.isConnected() ? 'retrying' : 'reconnecting',
      attempt: retryCount,
      detail: this.relay?.isConnected() ? 'Baixando novamente' : 'Aguardando reconexão ao Relay'
    });
    const previousTimer = this.groupFileDownloadRetryTimerByFileId.get(download.fileId);
    if (previousTimer) clearTimeout(previousTimer);
    const timeout = setTimeout(() => {
      this.groupFileDownloadRetryTimerByFileId.delete(download.fileId);
      if (!this.relay?.isConnected()) return;
      const message = this.db.getMessageById(download.messageId);
      if (this.hasUsableLocalAttachment(message)) {
        this.clearGroupFileDownloadRetry(download.fileId);
        return;
      }
      void this.requestGroupAttachmentIfNeeded({
        fileId: download.fileId,
        groupId: download.groupId,
        messageId: download.messageId,
        senderDeviceId: download.senderDeviceId
      }).catch(() => undefined);
    }, Math.min(5_000, 750 * 2 ** (retryCount - 1)));
    timeout.unref?.();
    this.groupFileDownloadRetryTimerByFileId.set(download.fileId, timeout);
  }

  private failGroupFileDownload(requestId: string, reason: string): void {
    void this.failGroupFileDownloadAsync(requestId, reason);
  }

  private async failGroupFileDownloadAsync(requestId: string, reason: string): Promise<void> {
    const download = this.groupFileDownloadByRequestId.get(requestId);
    if (!download) return;
    if (this.groupFileDownloadRequestIdByFileId.get(download.fileId) !== requestId) {
      this.clearGroupFileDownloadTimeout(requestId);
      this.groupFileDownloadByRequestId.delete(requestId);
      return;
    }
    this.clearGroupFileDownloadTimeout(requestId);
    this.groupFileDownloadByRequestId.delete(requestId);
    if (this.groupFileDownloadRequestIdByFileId.get(download.fileId) === requestId) {
      this.groupFileDownloadRequestIdByFileId.delete(download.fileId);
    }
    const checkpoint = await this.fileTransfer.pauseIncoming(download.fileId);
    if (checkpoint && this.isPermanentGroupFileDownloadError(reason)) {
      try {
        fs.unlinkSync(checkpoint.tempPath);
      } catch {
        // O banco será marcado como falha definitiva mesmo se o temporário já tiver sumido.
      }
    }
    if (checkpoint) {
      const previous = this.db.getGroupAttachmentDownload(download.fileId);
      this.db.upsertGroupAttachmentDownload({
        fileId: download.fileId,
        groupId: download.groupId,
        messageId: download.messageId,
        status: 'retrying',
        localPath: null,
        tempPath: checkpoint.tempPath,
        totalBytes: previous?.totalBytes || 0,
        receivedBytes: checkpoint.receivedBytes,
        nextChunkIndex: checkpoint.nextChunkIndex,
        totalChunks: checkpoint.totalChunks,
        retryCount: previous?.retryCount || 0,
        lastError: reason,
        lastAttemptAt: Date.now(),
        requestId: null,
        receivedAt: null,
        updatedAt: Date.now()
      });
    }
    this.scheduleGroupFileDownloadRetry(download, reason);
    this.groupFileDownloadCompletionByFileId.get(download.fileId)?.resolve();
    console.warn(`[Lantern][Relay] download de anexo de grupo interrompido: ${reason}`);
  }

  private async pauseGroupFileDownloadsForDisconnect(): Promise<void> {
    for (const timer of this.groupFileDownloadRetryTimerByFileId.values()) {
      clearTimeout(timer);
    }
    this.groupFileDownloadRetryTimerByFileId.clear();
    for (const [requestId, download] of Array.from(this.groupFileDownloadByRequestId.entries())) {
      this.clearGroupFileDownloadTimeout(requestId);
      this.groupFileDownloadByRequestId.delete(requestId);
      if (this.groupFileDownloadRequestIdByFileId.get(download.fileId) === requestId) {
        this.groupFileDownloadRequestIdByFileId.delete(download.fileId);
      }
      const checkpoint = await this.fileTransfer.pauseIncoming(download.fileId);
      const previous = this.db.getGroupAttachmentDownload(download.fileId);
      this.db.upsertGroupAttachmentDownload({
        fileId: download.fileId,
        groupId: download.groupId,
        messageId: download.messageId,
        status: 'reconnecting',
        localPath: null,
        tempPath: checkpoint?.tempPath || previous?.tempPath || null,
        totalBytes: previous?.totalBytes || 0,
        receivedBytes: checkpoint?.receivedBytes || previous?.receivedBytes || 0,
        nextChunkIndex: checkpoint?.nextChunkIndex || previous?.nextChunkIndex || 0,
        totalChunks: checkpoint?.totalChunks || previous?.totalChunks || 0,
        retryCount: previous?.retryCount || 0,
        lastError: 'Conexão com o Relay interrompida.',
        lastAttemptAt: Date.now(),
        requestId: null,
        receivedAt: null,
        updatedAt: Date.now()
      });
      const waiting = this.db.markIncomingFileForRetry(download.messageId);
      if (waiting) {
        this.emitEvent({ type: 'message:updated', message: waiting });
      }
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'receive',
        fileId: download.fileId,
        messageId: download.messageId,
        peerId: download.senderDeviceId,
        transferred: checkpoint?.receivedBytes || previous?.receivedBytes || 0,
        total: previous?.totalBytes || waiting?.fileSize || 0,
        stage: 'reconnecting',
        attempt: previous?.retryCount || 0,
        detail: 'Aguardando reconexão ao Relay'
      });
      this.groupFileDownloadCompletionByFileId.get(download.fileId)?.resolve();
    }
    this.groupFileDownloadRequestIdByFileId.clear();
  }

  private handleGroupFileStart(payload: { requestId: string; fileId: string; metadata: unknown }): void {
    const metadata = (payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata
      : null) as Record<string, unknown> | null;
    if (!metadata) return;
    const fileId = typeof metadata.fileId === 'string' ? metadata.fileId : payload.fileId;
    const groupId = typeof metadata.groupId === 'string' ? metadata.groupId : '';
    const messageId = typeof metadata.messageId === 'string' ? metadata.messageId : '';
    const senderDeviceId = typeof metadata.senderDeviceId === 'string' ? metadata.senderDeviceId : '';
    const filename = typeof metadata.fileName === 'string' ? metadata.fileName : 'arquivo';
    const size = typeof metadata.fileSize === 'number' ? metadata.fileSize : 0;
    const sha256 = typeof metadata.sha256 === 'string' ? metadata.sha256 : '';
    if (!fileId || !groupId || !messageId || !senderDeviceId) return;

    const tracked = this.groupFileDownloadByRequestId.get(payload.requestId);
    if (
      !tracked ||
      tracked.fileId !== fileId ||
      tracked.groupId !== groupId ||
      tracked.messageId !== messageId ||
      this.groupFileDownloadRequestIdByFileId.get(fileId) !== payload.requestId
    ) {
      return;
    }

    // A replayed request can arrive after a previous download already completed.
    // Do not truncate the verified local copy just because the Relay is replaying it.
    const existingMessage = this.db.getMessageById(messageId);
    if (this.hasUsableLocalAttachment(existingMessage)) {
      this.clearGroupFileDownloadRetry(fileId);
      this.finishGroupFileDownloadTracking(payload.requestId);
      void this.relay?.markGroupFileReceived(fileId).catch(() => undefined);
      return;
    }

    // O mesmo timeout passa a vigiar inatividade durante a transferência.
    this.scheduleGroupFileDownloadTimeout(payload.requestId);
    const previousDownload = this.db.getGroupAttachmentDownload(fileId);
    let finalPath: string;
    try {
      finalPath = this.fileTransfer.startIncoming(
        {
          fileId,
          messageId,
          filename,
          size,
          sha256
        },
        senderDeviceId,
        {
          tempPath: previousDownload?.tempPath,
          nextChunkIndex: previousDownload?.nextChunkIndex,
          receivedBytes: previousDownload?.receivedBytes
        }
      );
    } catch (error) {
      this.failGroupFileDownload(
        payload.requestId,
        error instanceof Error ? error.message : 'Não foi possível iniciar o download.'
      );
      return;
    }
    this.db.upsertGroupAttachmentDownload({
      fileId,
      groupId,
      messageId,
      status: 'downloading',
      localPath: null,
      tempPath: finalPath,
      totalBytes: size,
      receivedBytes: previousDownload?.receivedBytes || 0,
      nextChunkIndex: previousDownload?.nextChunkIndex || 0,
      totalChunks: Math.max(1, Math.ceil(size / FILE_CHUNK_SIZE_BYTES)),
      retryCount: previousDownload?.retryCount || 0,
      lastError: null,
      lastAttemptAt: Date.now(),
      requestId: payload.requestId,
      receivedAt: null,
      updatedAt: Date.now()
    });
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'receive',
      fileId,
      messageId,
      peerId: senderDeviceId,
      transferred: previousDownload?.receivedBytes || 0,
      total: size,
      stage: 'downloading',
      attempt: previousDownload?.retryCount || 0,
      detail: (previousDownload?.receivedBytes || 0) > 0 ? 'Retomando download' : 'Recebendo anexo'
    });
  }

  private handleGroupFileChunk(payload: {
    requestId: string;
    fileId: string;
    index: number;
    total: number;
    dataBase64: string;
  }): void {
    const download = this.groupFileDownloadByRequestId.get(payload.requestId);
    if (
      !download ||
      download.fileId !== payload.fileId ||
      this.groupFileDownloadRequestIdByFileId.get(payload.fileId) !== payload.requestId
    ) {
      return;
    }
    let progress: { transferred: number; total: number };
    try {
      progress = this.fileTransfer.onChunk({
        fileId: payload.fileId,
        index: payload.index,
        total: payload.total,
        dataBase64: payload.dataBase64
      });
    } catch (error) {
      this.failGroupFileDownload(
        payload.requestId,
        error instanceof Error ? error.message : 'Chunk inválido recebido do Relay.'
      );
      return;
    }
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'receive',
      fileId: payload.fileId,
      messageId: download.messageId,
      peerId: download.senderDeviceId,
      transferred: progress.transferred,
      total: progress.total,
      stage: 'downloading',
      attempt: this.db.getGroupAttachmentDownload(payload.fileId)?.retryCount || 0,
      detail: 'Recebendo anexo'
    });
    const current = this.db.getGroupAttachmentDownload(payload.fileId);
    this.db.upsertGroupAttachmentDownload({
      fileId: payload.fileId,
      groupId: download.groupId,
      messageId: download.messageId,
      status: 'downloading',
      localPath: null,
      tempPath: current?.tempPath || null,
      totalBytes: progress.total,
      receivedBytes: progress.transferred,
      nextChunkIndex: payload.index + 1,
      totalChunks: payload.total,
      retryCount: current?.retryCount || 0,
      lastError: null,
      lastAttemptAt: current?.lastAttemptAt || Date.now(),
      requestId: payload.requestId,
      receivedAt: null,
      updatedAt: Date.now()
    });
    this.scheduleGroupFileDownloadTimeout(payload.requestId);
  }

  private async handleGroupFileComplete(payload: { requestId: string; fileId: string }): Promise<void> {
    const download = this.groupFileDownloadByRequestId.get(payload.requestId);
    if (
      !download ||
      download.fileId !== payload.fileId ||
      this.groupFileDownloadRequestIdByFileId.get(payload.fileId) !== payload.requestId
    ) {
      return;
    }
    this.clearGroupFileDownloadTimeout(payload.requestId);
    try {
      const messageBeforeFinalize = this.db.getMessageById(download.messageId);
      const expectedSize = messageBeforeFinalize?.fileSize || 0;
      const result = await this.fileTransfer.finalize(payload.fileId);
      this.db.updateFilePath(payload.fileId, result.finalPath, result.ok ? 'delivered' : 'failed');
      this.db.upsertGroupAttachmentDownload({
        fileId: payload.fileId,
        groupId: download.groupId,
        messageId: download.messageId,
        status: result.ok ? 'complete' : 'failed',
        localPath: result.ok ? result.finalPath : null,
        tempPath: null,
        totalBytes: expectedSize,
        receivedBytes: result.ok ? expectedSize : 0,
        nextChunkIndex: result.ok
          ? Math.max(1, Math.ceil(expectedSize / FILE_CHUNK_SIZE_BYTES))
          : 0,
        totalChunks: Math.max(1, Math.ceil(expectedSize / FILE_CHUNK_SIZE_BYTES)),
        retryCount: result.ok ? 0 : this.db.getGroupAttachmentDownload(payload.fileId)?.retryCount || 0,
        lastError: result.ok ? null : 'Falha na validação de integridade do arquivo.',
        lastAttemptAt: Date.now(),
        requestId: null,
        receivedAt: result.ok ? Date.now() : null,
        updatedAt: Date.now()
      });
      const updated = this.db.getMessageById(download.messageId);
      if (updated) {
        this.emitEvent({ type: 'message:updated', message: updated });
      }
      this.emitEvent({
        type: 'message:status',
        messageId: download.messageId,
        conversationId: updated?.conversationId || null,
        status: result.ok ? 'delivered' : 'failed'
      });
      if (result.ok) {
        this.clearGroupFileDownloadRetry(payload.fileId);
        this.emitEvent({
          type: 'transfer:progress',
          direction: 'receive',
          fileId: payload.fileId,
          messageId: download.messageId,
          peerId: download.senderDeviceId,
          transferred: updated?.fileSize || 0,
          total: updated?.fileSize || 0,
          stage: 'complete',
          attempt: 0,
          detail: 'Concluído'
        });
        await this.relay?.markGroupFileReceived(payload.fileId).catch(() => undefined);
      } else {
        this.scheduleGroupFileDownloadRetry(download, 'Validação do arquivo recebida com erro.');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.scheduleGroupFileDownloadRetry(download, reason);
      console.warn(
        '[Lantern][Relay] falha ao validar anexo de grupo:',
        reason
      );
    } finally {
      this.finishGroupFileDownloadTracking(payload.requestId);
    }
  }

  private async createGroup(input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }): Promise<GroupInfo> {
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    const ack = await this.relay.sendGroupAction('create', {
      name: input.name,
      emoji: input.emoji,
      avatarBg: input.avatarBg,
      description: input.description,
      memberDeviceIds: input.memberDeviceIds
    });
    const group = ack.group as GroupInfo | undefined;
    if (!group?.groupId) {
      throw new Error('Relay não retornou o grupo criado.');
    }
    this.db.upsertGroup(group);
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
    return group;
  }

  private async updateGroup(
    groupId: string,
    input: {
      name?: string;
      emoji?: string;
      avatarBg?: string;
      description?: string;
      settings?: Record<string, boolean>;
    }
  ): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('update', {
        groupId,
        ...input
      });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
  }

  private async addGroupMembers(groupId: string, memberDeviceIds: string[]): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('addMembers', {
        groupId,
        memberDeviceIds
      });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
  }

  private async removeGroupMember(groupId: string, deviceId: string): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('removeMember', {
        groupId,
        deviceId
      });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
  }

  private async setGroupMemberRole(
    groupId: string,
    deviceId: string,
    role: 'admin' | 'member'
  ): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('changeRole', {
        groupId,
        deviceId,
        role
      });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
  }

  private async transferGroupOwnership(groupId: string, deviceId: string): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('transferOwnership', {
        groupId,
        deviceId
      });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
  }

  private async deleteGroup(groupId: string): Promise<void> {
    const localGroup = this.db.getGroupById(groupId);
    if (localGroup?.missingOnRelay) {
      this.deleteLocalGroup(groupId);
      return;
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('deleteGroup', { groupId });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.deleteLocalGroup(groupId);
        return;
      }
      throw error;
    }
    const group = this.db.getGroupById(groupId);
    if (group) {
      this.db.upsertGroup({ ...group, deletedAt: Date.now(), updatedAt: Date.now() });
    }
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
  }

  private async leaveGroup(groupId: string): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (group?.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    try {
      await this.relay.sendGroupAction('leave', { groupId });
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(groupId);
      }
      throw error;
    }
    const current = this.db
      .getGroupMembers(groupId)
      .find((member) => member.deviceId === this.profile.deviceId);
    this.db.upsertGroupMembers(groupId, [
      {
        groupId,
        deviceId: this.profile.deviceId,
        role: current?.role || 'member',
        status: 'left',
        displayNameSnapshot: current?.displayNameSnapshot || this.profile.displayName,
        avatarEmojiSnapshot: current?.avatarEmojiSnapshot || this.profile.avatarEmoji,
        avatarBgSnapshot: current?.avatarBgSnapshot || this.profile.avatarBg,
        joinedAt: current?.joinedAt || Date.now(),
        updatedAt: Date.now()
      }
    ]);
    this.emitEvent({
      type: 'group:members',
      groupId,
      members: this.db.getGroupMembers(groupId)
    });
    this.emitEvent({ type: 'groups:updated', groups: this.getVisibleGroups() });
  }

  private async setGroupMessagePinned(
    groupId: string,
    messageId: string,
    pinned: boolean
  ): Promise<void> {
    const group = this.db.getGroupById(groupId);
    if (!group) {
      throw new Error('Grupo não encontrado.');
    }
    if (group.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }

    const next = this.db.setGroupMessagePinned(
      group.groupId,
      messageId,
      pinned,
      this.profile.deviceId,
      Date.now()
    );
    this.emitEvent({ type: 'group:pins', groupId: group.groupId, messageIds: next });

    try {
      await this.relay.sendGroupAction(pinned ? 'pin' : 'unpin', {
        groupId: group.groupId,
        messageId
      });
    } catch (error) {
      const reverted = this.db.setGroupMessagePinned(
        group.groupId,
        messageId,
        !pinned,
        this.profile.deviceId,
        Date.now()
      );
      this.emitEvent({ type: 'group:pins', groupId: group.groupId, messageIds: reverted });
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(group.groupId);
      }
      throw error;
    }
  }

  private async sendGroupText(
    groupId: string,
    text: string,
    replyTo?: MessageReplyPayload | null
  ): Promise<DbMessage> {
    const group = this.db.getGroupById(groupId);
    if (!group) {
      throw new Error('Grupo não encontrado.');
    }
    if (group.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    const conversationId = this.db.ensureGroupConversation(group.groupId, group.name);
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const messageId = randomUUID();
    const sanitizedReply = this.sanitizeGroupReply(replyTo);
    const message: DbMessage = {
      messageId,
      conversationId,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: null,
      type: 'text',
      bodyText: text,
      fileId: null,
      fileName: null,
      fileSize: null,
      fileSha256: null,
      filePath: null,
      status: 'sent',
      reaction: null,
      deletedAt: null,
      replyToMessageId: sanitizedReply?.messageId || null,
      replyToSenderDeviceId: sanitizedReply?.senderDeviceId || null,
      replyToType: sanitizedReply?.type || null,
      replyToPreviewText: sanitizedReply?.previewText || null,
      replyToFileName: sanitizedReply?.fileName || null,
      forwardedFromMessageId: null,
      editedAt: null,
      createdAt
    };
    this.db.saveMessage(message);
    this.emitEvent({ type: 'message:received', message });
    try {
      await this.relay.sendGroupAction('sendText', {
        groupId: group.groupId,
        messageId,
        text,
        replyTo: sanitizedReply,
        createdAt
      });
      this.db.updateMessageStatus(messageId, 'delivered');
      const delivered = this.db.getMessageById(messageId) || { ...message, status: 'delivered' as const };
      this.emitEvent({ type: 'message:updated', message: delivered });
    } catch (error) {
      this.db.updateMessageStatus(messageId, 'failed');
      const failed = this.db.getMessageById(messageId) || { ...message, status: 'failed' as const };
      this.emitEvent({ type: 'message:updated', message: failed });
      if (this.isGroupMissingOnRelayError(error)) {
        this.markGroupMissingOnRelay(group.groupId);
      }
      throw error;
    }
    return this.db.getMessageById(messageId) || message;
  }

  private async sendGroupFile(
    groupId: string,
    filePath: string,
    replyTo?: MessageReplyPayload | null
  ): Promise<DbMessage> {
    const group = this.db.getGroupById(groupId);
    if (!group) {
      throw new Error('Grupo não encontrado.');
    }
    if (group.missingOnRelay) {
      throw new Error('Grupo não existe mais no Relay.');
    }
    if (!this.relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    const conversationId = this.db.ensureGroupConversation(group.groupId, group.name);
    const createdAt = this.db.reserveConversationTimestamp(conversationId, Date.now());
    const messageId = randomUUID();
    const managedFilePath = await this.ensureManagedOutgoingFileCopy(filePath, messageId);
    const { offer } = await this.fileTransfer.createOffer(group.groupId, managedFilePath, messageId);
    this.cleanupEphemeralOutgoingFile(filePath);
    const sanitizedReply = this.sanitizeGroupReply(replyTo);
    const message: DbMessage = {
      messageId,
      conversationId,
      direction: 'out',
      senderDeviceId: this.profile.deviceId,
      receiverDeviceId: null,
      type: 'file',
      bodyText: null,
      fileId: offer.fileId,
      fileName: offer.filename,
      fileSize: offer.size,
      fileSha256: offer.sha256,
      filePath: managedFilePath,
      status: 'sent',
      reaction: null,
      deletedAt: null,
      replyToMessageId: sanitizedReply?.messageId || null,
      replyToSenderDeviceId: sanitizedReply?.senderDeviceId || null,
      replyToType: sanitizedReply?.type || null,
      replyToPreviewText: sanitizedReply?.previewText || null,
      replyToFileName: sanitizedReply?.fileName || null,
      forwardedFromMessageId: null,
      editedAt: null,
      createdAt
    };
    this.db.saveMessage(message);
    this.emitEvent({ type: 'message:received', message });
    this.emitEvent({
      type: 'transfer:progress',
      direction: 'send',
      fileId: offer.fileId,
      messageId,
      peerId: group.groupId,
      transferred: 0,
      total: offer.size,
      stage: 'pending',
      attempt: 0,
      detail: 'Preparando envio'
    });

    try {
      await this.uploadGroupFileToRelay(group, message, offer, sanitizedReply);
      this.db.updateMessageStatus(messageId, 'delivered');
      const delivered = this.db.getMessageById(messageId) || { ...message, status: 'delivered' as const };
      this.emitEvent({ type: 'message:updated', message: delivered });
      return delivered;
    } catch (error) {
      if (this.isGroupMissingOnRelayError(error)) {
        this.db.updateMessageStatus(messageId, 'failed');
        const failed = this.db.getMessageById(messageId) || message;
        this.emitEvent({ type: 'message:updated', message: failed });
        this.markGroupMissingOnRelay(group.groupId);
        throw error;
      }
      const uploadState = this.db.getGroupAttachmentUpload(offer.fileId);
      if (uploadState?.status === 'failed') {
        this.db.updateMessageStatus(messageId, 'failed');
        const failed = this.db.getMessageById(messageId) || message;
        this.emitEvent({ type: 'message:updated', message: failed });
        throw error;
      }
      this.db.updateMessageStatus(messageId, 'sent');
      const pending = this.db.getMessageById(messageId) || message;
      this.emitEvent({ type: 'message:updated', message: pending });
      return pending;
    }
  }

  private async uploadGroupFileToRelay(
    group: GroupInfo,
    message: DbMessage,
    offer: FileOfferPayload,
    replyTo: MessageReplyPayload | null
  ): Promise<void> {
    const relay = this.relay;
    if (!relay?.isConnected()) {
      throw new Error('Relay offline.');
    }
    if (!message.filePath || !fs.existsSync(message.filePath)) {
      throw new Error('Arquivo local não está mais disponível para envio.');
    }
    if (this.groupFileUploadsInFlight.has(offer.fileId)) {
      return;
    }
    this.groupFileUploadsInFlight.add(offer.fileId);
    const previousUpload = this.db.getGroupAttachmentUpload(offer.fileId);
    const retryCount = Math.max(0, previousUpload?.retryCount || 0);
    const totalChunks = this.fileTransfer.getChunkCountForSize(offer.size);
    this.db.upsertGroupAttachmentUpload({
      fileId: offer.fileId,
      groupId: group.groupId,
      messageId: message.messageId,
      status: retryCount > 0 ? 'retrying' : 'pending',
      totalBytes: offer.size,
      sentBytes: previousUpload?.sentBytes || 0,
      nextChunkIndex: previousUpload?.nextChunkIndex || 0,
      totalChunks,
      retryCount,
      lastError: previousUpload?.lastError || null,
      lastAttemptAt: Date.now(),
      updatedAt: Date.now()
    });
    try {
      const initAck = await relay.sendGroupAction('file:init', {
        createdAt: message.createdAt,
        offer: { ...offer, groupId: group.groupId, replyTo }
      });

      const requestedResumeIndex = Number(initAck.nextIndex);
      const resumeIndex = Number.isSafeInteger(requestedResumeIndex) && requestedResumeIndex >= 0
        ? requestedResumeIndex
        : 0;

      let transferred = Math.min(offer.size, resumeIndex * FILE_CHUNK_SIZE_BYTES);
      this.db.upsertGroupAttachmentUpload({
        fileId: offer.fileId,
        groupId: group.groupId,
        messageId: message.messageId,
        status: 'uploading',
        totalBytes: offer.size,
        sentBytes: transferred,
        nextChunkIndex: resumeIndex,
        totalChunks,
        retryCount,
        lastError: null,
        lastAttemptAt: Date.now(),
        updatedAt: Date.now()
      });
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'send',
        fileId: offer.fileId,
        messageId: message.messageId,
        peerId: group.groupId,
        transferred,
        total: offer.size,
        stage: 'uploading',
        attempt: retryCount,
        detail: resumeIndex > 0 ? 'Retomando envio' : 'Enviando anexo'
      });
      const inFlightChunks: Promise<void>[] = [];
      for await (const chunk of this.fileTransfer.createChunkStream(
        message.filePath,
        offer.fileId,
        resumeIndex
      )) {
        const bytes = Buffer.byteLength(chunk.dataBase64, 'base64');
        const sendChunk = relay.sendGroupFileChunk(chunk).then(() => {
          transferred = Math.min(offer.size, transferred + bytes);
          this.db.upsertGroupAttachmentUpload({
            fileId: offer.fileId,
            groupId: group.groupId,
            messageId: message.messageId,
            status: 'uploading',
            totalBytes: offer.size,
            sentBytes: transferred,
            nextChunkIndex: chunk.index + 1,
            totalChunks: chunk.total,
            retryCount,
            lastError: null,
            lastAttemptAt: Date.now(),
            updatedAt: Date.now()
          });
          this.emitEvent({
            type: 'transfer:progress',
            direction: 'send',
            fileId: offer.fileId,
            messageId: message.messageId,
            peerId: group.groupId,
            transferred,
            total: offer.size,
            stage: 'uploading',
            attempt: retryCount,
            detail: 'Enviando anexo'
          });
        });
        inFlightChunks.push(sendChunk);
        if (inFlightChunks.length >= this.groupUploadWindowSize) {
          await inFlightChunks.shift();
        }
      }
      if (transferred > 0) {
        this.emitEvent({
          type: 'transfer:progress',
          direction: 'send',
          fileId: offer.fileId,
          messageId: message.messageId,
          peerId: group.groupId,
          transferred,
          total: offer.size,
          stage: 'uploading',
          attempt: retryCount,
          detail: 'Enviando anexo'
        });
      }
      await Promise.all(inFlightChunks);
      await relay.completeGroupFile(offer.fileId);
      this.db.upsertGroupAttachmentUpload({
        fileId: offer.fileId,
        groupId: group.groupId,
        messageId: message.messageId,
        status: 'complete',
        totalBytes: offer.size,
        sentBytes: offer.size,
        nextChunkIndex: totalChunks,
        totalChunks,
        retryCount: 0,
        lastError: null,
        lastAttemptAt: Date.now(),
        updatedAt: Date.now()
      });
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'send',
        fileId: offer.fileId,
        messageId: message.messageId,
        peerId: group.groupId,
        transferred: offer.size,
        total: offer.size,
        stage: 'complete',
        attempt: retryCount,
        detail: 'Concluído'
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = this.db.getGroupAttachmentUpload(offer.fileId);
      const nextRetryCount = Math.max(0, current?.retryCount || 0) + 1;
      this.db.upsertGroupAttachmentUpload({
        fileId: offer.fileId,
        groupId: group.groupId,
        messageId: message.messageId,
        status: nextRetryCount > this.groupFileDownloadMaxRetries ? 'failed' : 'retrying',
        totalBytes: offer.size,
        sentBytes: current?.sentBytes || 0,
        nextChunkIndex: current?.nextChunkIndex || 0,
        totalChunks,
        retryCount: nextRetryCount,
        lastError: reason,
        lastAttemptAt: Date.now(),
        updatedAt: Date.now()
      });
      this.emitEvent({
        type: 'transfer:progress',
        direction: 'send',
        fileId: offer.fileId,
        messageId: message.messageId,
        peerId: group.groupId,
        transferred: current?.sentBytes || 0,
        total: offer.size,
        stage: nextRetryCount > this.groupFileDownloadMaxRetries ? 'failed' : 'reconnecting',
        attempt: nextRetryCount,
        detail:
          nextRetryCount > this.groupFileDownloadMaxRetries
            ? 'Não foi possível concluir o envio'
            : 'Aguardando reconexão ao Relay'
      });
      if (nextRetryCount <= this.groupFileDownloadMaxRetries) {
        const retryTimer = setTimeout(() => {
          if (this.relay?.isConnected()) {
            void this.resumePendingGroupFiles();
          }
        }, Math.min(10_000, 1_000 * 2 ** (nextRetryCount - 1)));
        retryTimer.unref?.();
      }
      throw error;
    } finally {
      this.groupFileUploadsInFlight.delete(offer.fileId);
    }
  }

  private async resumePendingGroupFiles(): Promise<void> {
    if (!this.relay?.isConnected()) return;
    for (const message of this.db.getPendingOutgoingGroupFiles()) {
      const groupId = this.groupIdFromConversationId(message.conversationId);
      if (!groupId || !message.fileId || !message.filePath || !fs.existsSync(message.filePath)) continue;
      const group = this.db.getGroupById(groupId);
      if (!group || group.missingOnRelay || this.groupFileUploadsInFlight.has(message.fileId)) continue;
      const uploadState = this.db.getGroupAttachmentUpload(message.fileId);
      if (
        uploadState?.status === 'failed' &&
        uploadState.retryCount > this.groupFileDownloadMaxRetries
      ) {
        continue;
      }
      try {
        const { offer } = await this.fileTransfer.createOffer(
          group.groupId,
          message.filePath,
          message.messageId,
          message.fileId,
          message.fileName || undefined
        );
        const replyTo = this.sanitizeGroupReply(
          message.replyToMessageId && message.replyToSenderDeviceId && message.replyToType
            ? {
                messageId: message.replyToMessageId,
                senderDeviceId: message.replyToSenderDeviceId,
                type: message.replyToType,
                previewText: message.replyToPreviewText,
                fileName: message.replyToFileName
              }
            : null
        );
        await this.uploadGroupFileToRelay(group, message, offer, replyTo);
        this.db.updateMessageStatus(message.messageId, 'delivered');
        const updated = this.db.getMessageById(message.messageId);
        if (updated) this.emitEvent({ type: 'message:updated', message: updated });
      } catch (error) {
        if (this.isGroupMissingOnRelayError(error)) {
          this.markGroupMissingOnRelay(group.groupId);
        }
        break;
      }
    }
  }

  private async resumePendingGroupAttachmentDownloads(): Promise<void> {
    if (!this.relay?.isConnected()) return;
    for (const download of this.db.getPendingGroupAttachmentDownloads()) {
      const message = this.db.getMessageById(download.messageId);
      if (!message?.fileId || !message.senderDeviceId) continue;
      if (message.filePath && fs.existsSync(message.filePath)) {
        this.db.upsertGroupAttachmentDownload({
          ...download,
          status: 'complete',
          localPath: message.filePath,
          receivedAt: Date.now(),
          updatedAt: Date.now()
        });
        await this.relay.markGroupFileReceived(message.fileId).catch(() => undefined);
        continue;
      }
      await this.requestGroupAttachmentIfNeeded({
        fileId: message.fileId,
        groupId: download.groupId,
        messageId: download.messageId,
        senderDeviceId: message.senderDeviceId
      });
    }
  }

  private handleRelayAnnouncementExpiry(messageIds: string[]): void {
    const removedIds = this.db.purgeAnnouncementMessageIds(messageIds);
    for (const messageId of removedIds) {
      this.emitEvent({
        type: 'message:removed',
        conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
        messageId
      });
    }
  }

  private async handleRelayAnnouncementSnapshot(
    frames: ProtocolFrame[],
    reactions: Record<string, Record<string, '👍' | '👎' | '❤️' | '😢' | '😊' | '😂'>> = {},
    reads: Record<string, Record<string, number>> = {}
  ): Promise<void> {
    const announceFrames = frames
      .filter((frame) => frame.type === 'announce')
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.messageId.localeCompare(b.messageId);
      });
    const snapshotIds = new Set(announceFrames.map((frame) => frame.messageId));

    for (const frame of announceFrames) {
      if (frame.from === this.profile.deviceId) {
        const existing = this.db.getMessageById(frame.messageId);
        if (!existing) {
          const payload = frame.payload as AnnouncementPayload;
          const replyTo = this.normalizeReplyPayload(payload.replyTo);
          const createdAt = this.db.reserveConversationTimestamp(
            ANNOUNCEMENTS_CONVERSATION_ID,
            this.normalizeInboundCreatedAt(frame.createdAt)
          );
          this.db.saveMessage({
            messageId: frame.messageId,
            conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
            direction: 'out',
            senderDeviceId: this.profile.deviceId,
            receiverDeviceId: null,
            type: 'announcement',
            bodyText: payload.text,
            fileId: null,
            fileName: null,
            fileSize: null,
            fileSha256: null,
            filePath: null,
            status: 'sent',
            reaction: null,
            deletedAt: null,
            replyToMessageId: replyTo?.messageId || null,
            replyToSenderDeviceId: replyTo?.senderDeviceId || null,
            replyToType: replyTo?.type || null,
            replyToPreviewText: replyTo?.previewText || null,
            replyToFileName: replyTo?.fileName || null,
            forwardedFromMessageId: null,
            editedAt:
              typeof payload.editedAt === 'number' && Number.isFinite(payload.editedAt)
                ? this.normalizeInboundCreatedAt(payload.editedAt)
                : null,
            createdAt
          });
        } else {
          const payload = frame.payload as AnnouncementPayload;
          if (typeof payload.editedAt === 'number' && Number.isFinite(payload.editedAt)) {
            const updated = this.db.updateMessageText(
              frame.messageId,
              payload.text,
              this.normalizeInboundCreatedAt(payload.editedAt)
            );
            if (updated) {
              this.emitEvent({ type: 'message:updated', message: updated });
            }
          }
        }
        continue;
      }
      await this.handleIncomingFrame(frame, 'sync');
    }

    const localIds = this.db.getActiveAnnouncementMessageIds();
    const missingIds = localIds.filter((id) => !snapshotIds.has(id));
    if (missingIds.length > 0) {
      const removedIds = this.db.purgeAnnouncementMessageIds(missingIds);
      for (const messageId of removedIds) {
        this.emitEvent({
          type: 'message:removed',
          conversationId: ANNOUNCEMENTS_CONVERSATION_ID,
          messageId
        });
      }
    }

    const touched = this.db.replaceAnnouncementReactions(reactions, { replaceAll: true });
    if (touched.length > 0) {
      const summaryByMessage = this.db.getAnnouncementReactionSummary(
        touched,
        this.profile.deviceId
      );
      for (const messageId of touched) {
        this.emitEvent({
          type: 'announcement:reactions',
          messageId,
          summary: summaryByMessage[messageId] || { counts: {}, myReaction: null }
        });
      }
    }

    const readTouched = this.db.replaceAnnouncementReads(reads, { replaceAll: true });
    if (readTouched.length > 0) {
      const summaryByMessage = this.db.getAnnouncementReadSummary(
        readTouched,
        this.profile.deviceId
      );
      for (const messageId of readTouched) {
        this.emitEvent({
          type: 'announcement:reads',
          messageId,
          summary: summaryByMessage[messageId] || { count: 0, readByMe: false }
        });
      }
    }
  }

  private handleRelayAnnouncementReactionUpdate(
    messageId: string,
    reactions: Record<string, '👍' | '👎' | '❤️' | '😢' | '😊' | '😂'>
  ): void {
    const touched = this.db.replaceAnnouncementReactions(
      { [messageId]: reactions },
      { replaceAll: false }
    );
    if (touched.length === 0) {
      return;
    }
    const summary = this.db.getAnnouncementReactionSummary(
      [messageId],
      this.profile.deviceId
    )[messageId] || { counts: {}, myReaction: null };
    this.emitEvent({
      type: 'announcement:reactions',
      messageId,
      summary
    });
  }

  private handleRelayAnnouncementReadUpdate(
    reads: Record<string, Record<string, number>>
  ): void {
    const touched = this.db.replaceAnnouncementReads(reads, { replaceAll: false });
    if (touched.length === 0) {
      return;
    }
    const summaryByMessage = this.db.getAnnouncementReadSummary(
      touched,
      this.profile.deviceId
    );
    for (const messageId of touched) {
      this.emitEvent({
        type: 'announcement:reads',
        messageId,
        summary: summaryByMessage[messageId] || { count: 0, readByMe: false }
      });
    }
  }
}

const bootstrap = async (): Promise<void> => {
  const instanceTag = (process.env.LANTERN_INSTANCE || '').trim();
  const isMultiInstanceDev = Boolean(instanceTag);

  if (instanceTag) {
    const safeTag = instanceTag.replace(/[^a-zA-Z0-9_-]/g, '_');
    const defaultUserData = app.getPath('userData');
    app.setPath('userData', path.join(defaultUserData, `instance-${safeTag}`));
  }

  if (!isMultiInstanceDev) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      if (win.isMinimized()) {
        win.restore();
      }
      if (!win.isVisible()) {
        win.show();
      }
      win.focus();
    });
  }

  await app.whenReady();
  const lantern = new LanternApp();
  try {
    await lantern.start();
  } catch (error) {
    console.error('[Lantern] Falha ao iniciar aplicação:', error);
    app.exit(1);
    return;
  }

  app.on('activate', () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) {
      void lantern.start();
      return;
    }
    const win = windows[0];
    if (win.isMinimized()) {
      win.restore();
    }
    if (!win.isVisible()) {
      win.show();
    }
    win.focus();
  });
};

process.on('uncaughtException', (error) => {
  console.error('[Lantern] uncaughtException:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Lantern] unhandledRejection:', reason);
});

void bootstrap();
