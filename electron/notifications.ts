import path from 'node:path';
import { app, BrowserWindow, Notification, nativeImage } from 'electron';

interface NotificationAvatar {
  emoji: string;
  bg: string;
}

export class NotificationService {
  private muted = false;
  private readonly getWindow: () => BrowserWindow | null;
  private onNavigate: ((conversationId: string) => void) | null = null;
  private unreadAttentionCount = 0;
  private notificationIcon: Electron.NativeImage | null = null;
  private readonly overlayBadgeCache = new Map<string, Electron.NativeImage>();
  private readonly avatarNotificationIconCache = new Map<string, Electron.NativeImage>();

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
    this.notificationIcon = this.loadNotificationIcon();
    app.on('browser-window-focus', () => {
      this.stopAttention();
    });
  }

  setMuted(value: boolean): void {
    this.muted = value;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setNavigateHandler(handler: (conversationId: string) => void): void {
    this.onNavigate = handler;
  }

  shouldNotify(): boolean {
    const win = this.getWindow();
    if (!win) return true;
    if (!win.isVisible()) return true;
    if (win.isMinimized()) return true;
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (!focusedWindow || focusedWindow.id !== win.id) return true;
    if (!win.isFocused()) return true;
    return false;
  }

  notifyMessage(
    senderName: string,
    preview: string,
    conversationId: string,
    avatar?: NotificationAvatar
  ): void {
    if (this.muted) {
      return;
    }
    this.showNotification(senderName, preview.slice(0, 120), conversationId, avatar);
  }

  notifyAnnouncement(preview: string, avatar?: NotificationAvatar): void {
    if (this.muted) {
      return;
    }
    this.showNotification('📢 Anúncio', preview.slice(0, 120), 'announcements', avatar);
  }

  private showNotification(
    title: string,
    body: string,
    conversationId: string,
    avatar?: NotificationAvatar
  ): void {
    let shown = false;
    try {
      if (Notification.isSupported()) {
        const icon = avatar ? this.createAvatarNotificationIcon(avatar) || this.notificationIcon : this.notificationIcon;
        const notif = new Notification({
          title,
          body,
          icon: icon || undefined,
          silent: true
        });
        notif.on('click', () => {
          this.onNavigate?.(conversationId);
        });
        notif.on('show', () => {
          shown = true;
        });
        notif.on('failed', () => {
          this.bumpAttention();
        });
        notif.show();
        shown = true;
      }
    } catch {
      shown = false;
    }

    // Reforco visual para casos em que o toast nativo falha/silencia.
    this.bumpAttention();

    if (!shown) {
      return;
    }
  }

  private createAvatarNotificationIcon(avatar: NotificationAvatar): Electron.NativeImage | null {
    const emoji = (avatar.emoji || '').trim();
    if (!emoji) {
      return this.notificationIcon;
    }

    const bg = /^#[0-9a-fA-F]{6}$/.test(avatar.bg) ? avatar.bg : '#5b5fc7';
    const key = `${emoji}|${bg}`;
    const cached = this.avatarNotificationIconCache.get(key);
    if (cached) {
      return cached;
    }

    const escapedEmoji = emoji
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="61" fill="${bg}" stroke="#ffffff" stroke-width="6" />
        <text x="64" y="82" text-anchor="middle" font-size="68"
          font-family="Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif">${escapedEmoji}</text>
      </svg>
    `;
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const image = nativeImage.createFromDataURL(dataUrl).resize({
      width: 128,
      height: 128,
      quality: 'best'
    });
    if (image.isEmpty()) {
      return this.notificationIcon;
    }
    this.avatarNotificationIconCache.set(key, image);
    return image;
  }

  private bumpAttention(): void {
    this.unreadAttentionCount = Math.min(999, this.unreadAttentionCount + 1);
    this.applyAttentionBadge();
    this.bumpMacAttention();
    this.bumpWindowAttention();
  }

  private stopAttention(): void {
    this.unreadAttentionCount = 0;
    this.applyAttentionBadge();
    this.clearWindowOverlayBadge();
    if (process.platform === 'win32') {
      const win = this.getWindow();
      if (!win) return;
      try {
        win.flashFrame(false);
      } catch {
        // ignore
      }
    }
  }

  private bumpMacAttention(): void {
    if (process.platform !== 'darwin') return;
    try {
      app.dock?.bounce('informational');
    } catch {
      // ignora se não suportado no ambiente atual
    }
  }

  private bumpWindowAttention(): void {
    if (process.platform !== 'win32') return;
    const win = this.getWindow();
    if (!win) return;

    try {
      win.flashFrame(true);
    } catch {
      // ignore
    }
  }

  private applyAttentionBadge(): void {
    if (process.platform === 'darwin') {
      app.setBadgeCount(this.unreadAttentionCount);
      return;
    }

    if (process.platform === 'win32') {
      this.applyWindowOverlayBadge();
    }
  }

  private applyWindowOverlayBadge(): void {
    const win = this.getWindow();
    if (!win) return;
    if (this.unreadAttentionCount <= 0) {
      this.clearWindowOverlayBadge();
      return;
    }

    const label =
      this.unreadAttentionCount > 99 ? '99+' : String(this.unreadAttentionCount);
    const cached = this.overlayBadgeCache.get(label);
    if (cached) {
      win.setOverlayIcon(cached, `${label} mensagens não lidas`);
      return;
    }

    const svg = this.createOverlayBadgeSvg(label);
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const badgeIcon = nativeImage.createFromDataURL(dataUrl).resize({
      width: 32,
      height: 32,
      quality: 'best'
    });
    if (badgeIcon.isEmpty()) {
      return;
    }
    this.overlayBadgeCache.set(label, badgeIcon);
    win.setOverlayIcon(badgeIcon, `${label} mensagens não lidas`);
  }

  private clearWindowOverlayBadge(): void {
    if (process.platform !== 'win32') return;
    const win = this.getWindow();
    if (!win) return;
    try {
      win.setOverlayIcon(null, '');
    } catch {
      // ignore
    }
  }

  private createOverlayBadgeSvg(label: string): string {
    const fontSize = label.length >= 3 ? 16 : 18;
    const x = label.length >= 3 ? 16 : 16;
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="15" fill="#f25022" stroke="#ffffff" stroke-width="2" />
        <text x="${x}" y="21" text-anchor="middle"
          font-family="Segoe UI, Arial, sans-serif"
          font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>
      </svg>
    `;
  }

  private loadNotificationIcon(): Electron.NativeImage | null {
    const candidates = [
      path.join(__dirname, '..', 'assets', 'icon.png'),
      path.join(process.cwd(), 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png'),
      path.join(__dirname, '..', 'assets', 'tray_white.png'),
      path.join(__dirname, '..', 'assets', 'tray_black.png'),
      path.join(process.cwd(), 'assets', 'tray_white.png'),
      path.join(process.cwd(), 'assets', 'tray_black.png'),
      path.join(process.resourcesPath, 'assets', 'tray_white.png'),
      path.join(process.resourcesPath, 'assets', 'tray_black.png'),
      path.join(process.resourcesPath, 'app.asar', 'assets', 'tray_white.png'),
      path.join(process.resourcesPath, 'app.asar', 'assets', 'tray_black.png'),
      path.join(__dirname, '..', 'build', 'icon.png'),
      path.join(process.cwd(), 'build', 'icon.png'),
      path.join(process.resourcesPath, 'build', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar', 'build', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.png')
    ];
    for (const candidate of candidates) {
      const icon = nativeImage.createFromPath(candidate);
      if (!icon.isEmpty()) {
        return icon;
      }
    }
    return null;
  }
}
