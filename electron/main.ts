import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  ANNOUNCEMENTS_CONVERSATION_ID,
  APP_ID,
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
import {
  AckPayload,
  AnnouncementPayload,
  AppEvent,
  ChatTextPayload,
  ClearConversationPayload,
  DeletePayload,
  DbMessage,
  FileChunkPayload,
  FileCompletePayload,
  ForgetPeerPayload,
  FileOfferPayload,
  MessageReplyPayload,
  Peer,
  Profile,
  ProtocolFrame,
  ReactPayload,
  SyncRequestPayload,
  SyncResponsePayload,
  TypingPayload
} from './types';

class LanternApp {
  private mainWindow: BrowserWindow | null = null;
  private quitting = false;
  private db!: DbService;
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
  private syncActivityCount = 0;
  private syncIdleTimer: NodeJS.Timeout | null = null;
  private readonly syncIdleGraceMs = 450;

  private formatBackupTimestamp(value: number): string {
    const date = new Date(value);
    const pad = (num: number) => String(num).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      '-',
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join('');
  }

  private async copyDirectoryRecursive(source: string, target: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.cp(source, target, {
      recursive: true,
      force: true,
      errorOnExist: false
    });
  }

  private async applyPendingRestoreIfExists(): Promise<void> {
    const userDataDir = app.getPath('userData');
    const stagingRoot = path.join(userDataDir, 'restore-pending');
    const markerPath = path.join(stagingRoot, 'restore.json');

    if (!fs.existsSync(markerPath)) {
      return;
    }

    try {
      const markerRaw = await fs.promises.readFile(markerPath, 'utf8');
      const marker = JSON.parse(markerRaw) as {
        targetAttachmentsDir?: string;
      };
      const stagedDbDir = path.join(stagingRoot, 'db');
      const stagedDbFile = path.join(stagedDbDir, 'lantern.db');
      if (!fs.existsSync(stagedDbFile)) {
        throw new Error('Backup pendente sem banco de dados válido.');
      }

      await fs.promises.mkdir(userDataDir, { recursive: true });
      const dbFileNames = ['lantern.db', 'lantern.db-wal', 'lantern.db-shm'] as const;
      for (const fileName of dbFileNames) {
        const targetPath = path.join(userDataDir, fileName);
        await fs.promises.rm(targetPath, { force: true }).catch(() => undefined);
        const stagedPath = path.join(stagedDbDir, fileName);
        if (!fs.existsSync(stagedPath)) {
          continue;
        }
        await fs.promises.copyFile(stagedPath, targetPath);
      }

      const stagedAttachmentsDir = path.join(stagingRoot, 'attachments');
      const targetAttachmentsDir = (marker.targetAttachmentsDir || '').trim();
      if (targetAttachmentsDir && fs.existsSync(stagedAttachmentsDir)) {
        const targetResolved = path.resolve(targetAttachmentsDir);
        await fs.promises.rm(targetResolved, { recursive: true, force: true });
        await this.copyDirectoryRecursive(stagedAttachmentsDir, targetResolved);
      }
    } catch (error) {
      console.error(
        '[Lantern] Falha ao aplicar restauração pendente:',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await fs.promises.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

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

  private async createLocalBackup(): Promise<{
    canceled: boolean;
    backupPath: string | null;
  }> {
    const picker = this.mainWindow
      ? await dialog.showOpenDialog(this.mainWindow, {
          title: 'Escolher pasta para salvar backup',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Escolher pasta para salvar backup',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory', 'createDirectory']
        });

    if (picker.canceled || picker.filePaths.length === 0) {
      return { canceled: true, backupPath: null };
    }

    const targetParent = path.resolve(picker.filePaths[0]);
    const stamp = this.formatBackupTimestamp(Date.now());
    const backupRoot = path.join(targetParent, `LanternBackup-${stamp}`);
    const backupDbDir = path.join(backupRoot, 'db');
    const backupAttachmentsDir = path.join(backupRoot, 'attachments');
    const userDataDir = app.getPath('userData');
    const sourceDbPath = path.join(userDataDir, 'lantern.db');

    if (!fs.existsSync(sourceDbPath)) {
      throw new Error('Banco de dados local não encontrado para backup.');
    }

    await fs.promises.mkdir(backupDbDir, { recursive: true });
    const dbFileNames = ['lantern.db', 'lantern.db-wal', 'lantern.db-shm'] as const;
    for (const fileName of dbFileNames) {
      const sourcePath = path.join(userDataDir, fileName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      await fs.promises.copyFile(sourcePath, path.join(backupDbDir, fileName));
    }

    const attachmentsDir = this.getConfiguredAttachmentsDir();
    let copiedAttachments = false;
    if (attachmentsDir && fs.existsSync(attachmentsDir)) {
      const stat = await fs.promises.stat(attachmentsDir).catch(() => null);
      if (stat?.isDirectory()) {
        await this.copyDirectoryRecursive(attachmentsDir, backupAttachmentsDir);
        copiedAttachments = true;
      }
    }

    const manifest = {
      app: 'Lantern',
      version: app.getVersion(),
      createdAt: Date.now(),
      profileDeviceId: this.profile.deviceId,
      profileName: this.profile.displayName,
      includesAttachments: copiedAttachments
    };
    await fs.promises.writeFile(
      path.join(backupRoot, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    return { canceled: false, backupPath: backupRoot };
  }

  private async restoreLocalBackup(): Promise<{
    canceled: boolean;
    restartScheduled: boolean;
  }> {
    const picker = this.mainWindow
      ? await dialog.showOpenDialog(this.mainWindow, {
          title: 'Selecionar pasta do backup',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Selecionar pasta do backup',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory']
        });

    if (picker.canceled || picker.filePaths.length === 0) {
      return { canceled: true, restartScheduled: false };
    }

    const backupRoot = path.resolve(picker.filePaths[0]);
    const backupDbDir = path.join(backupRoot, 'db');
    const backupDbFile = path.join(backupDbDir, 'lantern.db');
    if (!fs.existsSync(backupDbFile)) {
      throw new Error(
        'Backup inválido: arquivo db/lantern.db não encontrado na pasta selecionada.'
      );
    }

    const userDataDir = app.getPath('userData');
    const stagingRoot = path.join(userDataDir, 'restore-pending');
    const stagingDbDir = path.join(stagingRoot, 'db');
    const stagingAttachmentsDir = path.join(stagingRoot, 'attachments');
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    await fs.promises.mkdir(stagingDbDir, { recursive: true });

    const dbFileNames = ['lantern.db', 'lantern.db-wal', 'lantern.db-shm'] as const;
    for (const fileName of dbFileNames) {
      const sourcePath = path.join(backupDbDir, fileName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }
      await fs.promises.copyFile(sourcePath, path.join(stagingDbDir, fileName));
    }

    const backupAttachmentsDir = path.join(backupRoot, 'attachments');
    const targetAttachmentsDir = this.getConfiguredAttachmentsDir();
    if (fs.existsSync(backupAttachmentsDir)) {
      const stat = await fs.promises.stat(backupAttachmentsDir).catch(() => null);
      if (stat?.isDirectory()) {
        await this.copyDirectoryRecursive(backupAttachmentsDir, stagingAttachmentsDir);
      }
    }

    await fs.promises.writeFile(
      path.join(stagingRoot, 'restore.json'),
      JSON.stringify(
        {
          createdAt: Date.now(),
          sourceBackupPath: backupRoot,
          targetAttachmentsDir
        },
        null,
        2
      ),
      'utf8'
    );

    this.emitEvent({
      type: 'ui:toast',
      level: 'info',
      message: 'Restauração preparada. O Lantern será reiniciado para aplicar o backup.'
    });

    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 220);

    return { canceled: false, restartScheduled: true };
  }

  async start(): Promise<void> {
    app.setName('Lantern');
    app.setAppUserModelId(APP_ID);
    const appIconPath = this.resolveAppIconPath();
    if (process.platform === 'darwin' && appIconPath) {
      try {
        app.dock?.setIcon(appIconPath);
      } catch {
        // ignore
      }
    }

    await this.applyPendingRestoreIfExists();
    this.db = new DbService(app.getPath('userData'));
    this.profile = this.db.getProfile();
    this.relaySettings = this.db.getRelaySettings();
    this.presence = new PresenceService();
    this.syncService = new SyncService(this.db, this.profile);

    this.mainWindow = this.createWindow();
    this.notifications = new NotificationService(() => this.mainWindow);
    this.tray = new TrayController();
    this.fileTransfer = new FileTransferService(this.getConfiguredAttachmentsDir(), this.profile);

    this.relay = new RelayClient(this.profile, {
      onFrame: (frame) => {
        void this.handleIncomingFrame(frame).catch((error) => {
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
      },
      onPresence: (peers) => {
        this.handleRelayPresence(peers);
      },
      onAnnouncementExpired: (messageIds) => {
        this.handleRelayAnnouncementExpiry(messageIds);
      },
      onAnnouncementSnapshot: (frames, reactions) => {
        void this.handleRelayAnnouncementSnapshot(frames, reactions).catch((error) => {
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
      onConnectionState: ({ connected, endpoint }) => {
        this.emitEvent({
          type: 'relay:connection',
          connected,
          endpoint
        });
        if (!connected) {
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
      },
      onWarning: (message) => {
        this.emitEvent({ type: 'ui:toast', level: 'warning', message });
      }
    });
    this.relay.setEndpointSettings(this.relaySettings);
    await this.relay.start();

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

    this.notifications.setNavigateHandler((conversationId) => {
      this.mainWindow?.show();
      this.mainWindow?.focus();
      this.emitEvent({ type: 'navigate', conversationId });
    });

    const ipc = registerIpc(this.mainWindow, {
      getProfile: () => this.db.getProfile(),
      updateProfile: (input) => {
        const updated = this.db.updateProfile(input);
        Object.assign(this.profile, updated);
        this.relay?.updateProfile(this.profile);
        return this.profile;
      },
      getKnownPeers: () => this.getKnownPeers(),
      getOnlinePeers: () => this.getVisibleOnlinePeers(),
      getRelaySettings: () => this.getRelaySettingsSnapshot(),
      getStartupSettings: () => this.getStartupSettingsSnapshot(),
      updateRelaySettings: (input) => this.updateRelaySettings(input),
      updateStartupSettings: (input) => this.updateStartupSettings(input),
      sendText: (peerId, text, replyTo) => this.messageService.sendText(peerId, text, replyTo),
      sendTyping: (peerId, isTyping) => this.sendTyping(peerId, isTyping),
      sendAnnouncement: (text, replyTo) => this.messageService.sendAnnouncement(text, replyTo),
      sendFile: (peerId, filePath, replyTo) => this.messageService.sendFile(peerId, filePath, replyTo),
      forwardMessageToPeer: (targetPeerId, sourceMessageId) =>
        this.forwardMessageToPeer(targetPeerId, sourceMessageId),
      reactToMessage: (conversationId, messageId, reaction) =>
        this.reactToMessage(conversationId, messageId, reaction),
      deleteMessageForEveryone: (conversationId, messageId) =>
        this.deleteMessageForEveryone(conversationId, messageId),
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
      setActiveConversation: (conversationId) => {
        this.activeConversationId = conversationId;
        this.markConversationRead(conversationId);
      },
      markConversationRead: (conversationId) => this.markConversationRead(conversationId),
      markConversationUnread: (conversationId) => this.db.markConversationUnread(conversationId),
      clearConversation: (conversationId) => this.clearConversation(conversationId),
      forgetContactConversation: (conversationId) => this.forgetContactConversation(conversationId),
      getConversations: () =>
        Object.fromEntries(
          this.db
            .getConversations()
            .map((conversation) => [conversation.id, conversation.unreadCount])
        ),
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
      saveFileAs: (filePath, fileName) => this.saveFileAs(filePath, fileName),
      createLocalBackup: () => this.createLocalBackup(),
      restoreLocalBackup: () => this.restoreLocalBackup()
    });

    this.emitEvent = ipc.emitEvent;
    this.emitEvent({
      type: 'relay:connection',
      connected: this.relay?.isConnected() || false,
      endpoint: this.relay?.getCurrentEndpoint() || null
    });
    this.emitEvent({ type: 'sync:status', active: this.syncActivityCount > 0 });
    this.reconcileLegacyIncomingFilePaths();

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
  } {
    const supported = this.isStartupSettingsSupported();
    const downloadsDir =
      this.fileTransfer?.getAttachmentsDir?.() || this.getConfiguredAttachmentsDir();
    if (!supported) {
      return { supported: false, openAtLogin: false, downloadsDir };
    }
    const settings = app.getLoginItemSettings();
    return {
      supported: true,
      openAtLogin: Boolean(settings.openAtLogin),
      downloadsDir
    };
  }

  private updateStartupSettings(input: {
    openAtLogin: boolean;
    downloadsDir?: string;
  }): {
    supported: boolean;
    openAtLogin: boolean;
    downloadsDir: string;
  } {
    const defaultAttachmentsDir = this.getDefaultAttachmentsDir();
    const requestedDir = (input.downloadsDir || '').trim();
    if (requestedDir.length > 0) {
      const nextDir = this.db.setAttachmentsDirectory(requestedDir, defaultAttachmentsDir);
      this.fileTransfer.setAttachmentsDir(nextDir);
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
      await this.messageService.replayPendingFilesForPeer(peer);
    } catch (error) {
      if (throwOnFail) {
        throw error;
      }
      // peer offline ou inacessível; próxima presença online tentará novamente
    } finally {
      this.endSyncActivity();
    }
  }

  private async resyncConversation(conversationId: string): Promise<void> {
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

  private shouldMarkPeerUnreachableOnUndelivered(frame: ProtocolFrame): boolean {
    return (
      frame.type === 'chat:text' ||
      frame.type === 'file:offer' ||
      frame.type === 'chat:clear' ||
      frame.type === 'chat:forget'
    );
  }

  private async sendToPeer(peer: Peer, frame: ProtocolFrame): Promise<void> {
    if (!this.relay || !this.relay.isConnected()) {
      throw new Error('Relay offline.');
    }

    const targetDeviceId = frame.to;
    const result = await this.relay.sendFrame(frame);
    if (targetDeviceId && !result.deliveredTo.includes(targetDeviceId)) {
      if (this.shouldMarkPeerUnreachableOnUndelivered(frame)) {
        this.markPeerUnreachable(targetDeviceId, { force: true });
      }
      throw new Error('Contato offline no relay.');
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

  private markConversationRead(conversationId: string): void {
    this.db.markConversationRead(conversationId);

    if (!conversationId.startsWith('dm:')) {
      return;
    }

    const peer = this.getPeerFromConversationId(conversationId);
    if (!peer) {
      return;
    }

    const readMessageIds = this.db.markIncomingMessagesRead(conversationId, 1000);
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

  private bumpUnreadIfBackground(conversationId: string): void {
    const isVisibleFocused =
      Boolean(this.mainWindow) &&
      this.mainWindow!.isVisible() &&
      !this.mainWindow!.isMinimized() &&
      this.mainWindow!.isFocused();

    if (this.activeConversationId === conversationId && isVisibleFocused) {
      this.markConversationRead(conversationId);
      return;
    }
    this.db.incrementUnread(conversationId);
  }

  private notifyIncomingIfNeeded(
    message: Pick<
      DbMessage,
      'type' | 'bodyText' | 'conversationId' | 'senderDeviceId' | 'createdAt' | 'fileName'
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
        : undefined);
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
          : undefined
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
          : undefined
      );
    }
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

  private async flushPendingPeerOperations(peerId: string, peerOverride?: Peer): Promise<void> {
    const cleanPeerId = (peerId || '').trim();
    if (!cleanPeerId) return;
    if (!this.relay || !this.relay.isConnected()) return;

    const peer = peerOverride || this.resolvePeerForTransport(cleanPeerId);
    if (!peer) return;

    const pending = this.db.getPendingPeerOperations(cleanPeerId);
    if (pending.length === 0) return;

    for (const operation of pending) {
      const frame =
        operation.type === 'chat:clear'
          ? ({
              type: 'chat:clear',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: cleanPeerId,
              createdAt: Date.now(),
              payload: { scope: operation.payload.scope }
            } satisfies ProtocolFrame<ClearConversationPayload>)
          : ({
              type: 'chat:forget',
              messageId: randomUUID(),
              from: this.profile.deviceId,
              to: cleanPeerId,
              createdAt: Date.now(),
              payload: { scope: operation.payload.scope }
            } satisfies ProtocolFrame<ForgetPeerPayload>);
      try {
        await this.sendToPeer(peer, frame);
        this.db.removePendingPeerOperation(operation.id);
      } catch {
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

    const source = this.db.getMessageById(cleanSourceMessageId);
    if (!source || source.deletedAt) {
      throw new Error('Mensagem de origem não encontrada.');
    }

    const destinationPeer = this.resolvePeerForTransport(cleanTargetPeerId);
    if (!destinationPeer && !this.peersById.has(cleanTargetPeerId)) {
      throw new Error('Contato de destino não encontrado.');
    }

    if (source.type === 'file') {
      const sourceFilePath = (source.filePath || '').trim();
      if (!sourceFilePath || !fs.existsSync(sourceFilePath)) {
        throw new Error('Este anexo não está disponível para encaminhar.');
      }
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

    const isAnnouncementConversation =
      conversationId === ANNOUNCEMENTS_CONVERSATION_ID || targetMessage.type === 'announcement';
    const peer = this.getPeerFromConversationId(conversationId);
    if (peer) {
      const frame: ProtocolFrame<ReactPayload> = {
        type: 'chat:react',
        messageId: randomUUID(),
        from: this.profile.deviceId,
        to: peer.deviceId,
        createdAt: Date.now(),
        payload: {
          targetMessageId: messageId,
          reaction
        }
      };
      try {
        await this.sendToPeer(peer, frame);
      } catch {
        this.emitEvent({
          type: 'ui:toast',
          level: 'warning',
          message: 'Contato offline. Reação não enviada.'
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

    const summary = this.db.setMessageReaction(
      messageId,
      this.profile.deviceId,
      reaction,
      this.profile.deviceId
    );
    this.emitEvent({
      type: isAnnouncementConversation ? 'announcement:reactions' : 'message:reactions',
      messageId,
      summary
    });
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
      return;
    }

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
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(conversationId);
          this.emitEvent({ type: 'message:received', message: row });
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
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(ANNOUNCEMENTS_CONVERSATION_ID);
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
        const isAnnouncementReaction = target
          ? target.type === 'announcement'
          : frame.to === null;
        const summary = this.db.setMessageReaction(
          payload.targetMessageId,
          frame.from,
          payload.reaction,
          this.profile.deviceId
        );
        this.emitEvent({
          type: isAnnouncementReaction ? 'announcement:reactions' : 'message:reactions',
          messageId: payload.targetMessageId,
          summary
        });

        if (
          deliverySource === 'live' &&
          payload.reaction &&
          target &&
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
            await this.messageService.replayPendingFilesForPeer(activePeer);
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
              this.emitEvent({
                type: 'message:removed',
                conversationId: result.row.conversationId,
                messageId: result.row.messageId
              });
              continue;
            }

            if (result.inserted) {
              if (result.row.direction === 'in') {
                this.bumpUnreadIfBackground(result.row.conversationId);
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
            } else {
              this.emitEvent({ type: 'message:updated', message: result.row });
            }

            if (
              result.row.direction === 'in' &&
              (result.row.type === 'text' || result.row.type === 'announcement')
            ) {
              ackIds.push(result.row.messageId);
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
        const shouldReceiveFile =
          !existingMessage ||
          existingMessage.type !== 'file' ||
          !existingMessage.filePath ||
          existingMessage.status !== 'delivered';

        if (shouldReceiveFile) {
          this.fileTransfer.startIncoming(payload, frame.from);
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
          createdAt
        };

        const inserted = this.db.saveMessage(row);
        if (inserted) {
          this.bumpUnreadIfBackground(conversationId);
          this.emitEvent({ type: 'message:received', message: row });
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

        break;
      }
      case 'file:chunk': {
        const payload = frame.payload as FileChunkPayload;
        let progress: { done: boolean; transferred: number; total: number };
        try {
          progress = this.fileTransfer.onChunk(payload);
        } catch {
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
    reactions: Record<string, Record<string, '👍' | '👎' | '❤️' | '😢' | '😊' | '😂'>> = {}
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
            createdAt
          });
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
