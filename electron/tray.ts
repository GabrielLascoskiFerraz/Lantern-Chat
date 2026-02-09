import path from 'node:path';
import { execSync } from 'node:child_process';
import { BrowserWindow, Menu, Tray, nativeImage, nativeTheme } from 'electron';

interface TrayControllerDeps {
  appName: string;
  onQuit: () => void;
  onMuteChange: (muted: boolean) => void;
  isMuted: () => boolean;
}

export class TrayController {
  private tray: Tray | null = null;
  private shownCloseTip = false;
  private muted = false;
  private nativeThemeListener: (() => void) | null = null;

  create(window: BrowserWindow, deps: TrayControllerDeps): void {
    this.tray = new Tray(this.createTrayIcon());
    this.tray.setToolTip(deps.appName);

    const buildMenu = (): Menu =>
      Menu.buildFromTemplate([
        {
          label: 'Abrir',
          click: () => this.show(window)
        },
        {
          label: this.muted ? 'Ativar notificações' : 'Silenciar notificações',
          click: () => {
            this.muted = !this.muted;
            deps.onMuteChange(this.muted);
            this.tray?.setContextMenu(buildMenu());
          }
        },
        { type: 'separator' },
        {
          label: 'Sair',
          click: deps.onQuit
        }
      ]);

    this.muted = deps.isMuted();
    this.tray.setContextMenu(buildMenu());

    this.tray.on('click', () => {
      if (!window.isVisible() || window.isMinimized()) {
        this.show(window);
        return;
      }

      if (process.platform === 'win32') {
        window.minimize();
      } else {
        window.hide();
      }
    });

    if (this.nativeThemeListener) {
      nativeTheme.removeListener('updated', this.nativeThemeListener);
    }
    this.nativeThemeListener = () => {
      this.refreshTrayIcon();
    };
    nativeTheme.on('updated', this.nativeThemeListener);
  }

  show(window: BrowserWindow): void {
    if (process.platform === 'win32') {
      window.setSkipTaskbar(false);
    }
    window.show();
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  }

  hideToTray(window: BrowserWindow): void {
    if (process.platform === 'win32') {
      window.setSkipTaskbar(false);
      window.minimize();
    } else {
      window.hide();
    }
    if (!this.shownCloseTip && this.tray) {
      this.shownCloseTip = true;
      try {
        this.tray.displayBalloon({
          title: 'Lantern',
          content: 'Lantern continua em execução na bandeja do sistema.'
        });
      } catch {
        // não suportado em alguns ambientes
      }
    }
  }

  destroy(): void {
    if (this.nativeThemeListener) {
      nativeTheme.removeListener('updated', this.nativeThemeListener);
      this.nativeThemeListener = null;
    }
    this.tray?.destroy();
    this.tray = null;
  }

  private refreshTrayIcon(): void {
    if (!this.tray) return;
    this.tray.setImage(this.createTrayIcon());
  }

  private resolveTrayVariant(): 'white' | 'black' {
    if (process.platform === 'win32') {
      const taskbarDark = this.isWindowsTaskbarDark();
      if (typeof taskbarDark === 'boolean') {
        return taskbarDark ? 'white' : 'black';
      }
      return nativeTheme.shouldUseDarkColors ? 'white' : 'black';
    }
    if (process.platform === 'linux') {
      return nativeTheme.shouldUseDarkColors ? 'white' : 'black';
    }
    return 'black';
  }

  private isWindowsTaskbarDark(): boolean | null {
    try {
      const output = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme',
        { stdio: ['ignore', 'pipe', 'ignore'] }
      ).toString('utf8');
      const match = output.match(/SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i);
      if (!match) return null;
      const value = Number.parseInt(match[1], 16);
      if (!Number.isFinite(value)) return null;
      return value === 0;
    } catch {
      return null;
    }
  }

  private createTrayIcon() {
    const variant = this.resolveTrayVariant();
    const candidates = [
      path.join(__dirname, '..', 'assets', `tray_${variant}.png`),
      path.join(process.cwd(), 'assets', `tray_${variant}.png`),
      path.join(process.resourcesPath, 'assets', `tray_${variant}.png`),
      path.join(process.resourcesPath, 'app.asar', 'assets', `tray_${variant}.png`),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', `tray_${variant}.png`),
      path.join(__dirname, '..', 'assets', 'icon.png'),
      path.join(process.cwd(), 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar', 'assets', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'icon.png'),
      path.join(__dirname, '..', 'build', 'icon.png'),
      path.join(process.cwd(), 'build', 'icon.png'),
      path.join(process.resourcesPath, 'build', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar', 'build', 'icon.png'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'build', 'icon.png')
    ];

    let icon = nativeImage.createEmpty();
    for (const candidate of candidates) {
      const loaded = nativeImage.createFromPath(candidate);
      if (!loaded.isEmpty()) {
        icon = loaded;
        break;
      }
    }

    if (icon.isEmpty()) {
      icon = this.createBuiltInMessageIcon(variant);
    }

    const size = process.platform === 'darwin' ? 18 : 16;
    icon = icon.resize({ width: size, height: size, quality: 'best' });

    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }

    return icon;
  }

  private createBuiltInMessageIcon(variant: 'white' | 'black') {
    const monoFill = variant === 'white' ? '#ffffff' : '#000000';
    const monochromeSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
        <path fill="${monoFill}" d="M10 12c-3.3 0-6 2.7-6 6v23c0 3.3 2.7 6 6 6h9.2l11 8.2c1 .7 2.3-.1 2.3-1.4V47H54c3.3 0 6-2.7 6-6V18c0-3.3-2.7-6-6-6H10z"/>
        <circle cx="20" cy="30" r="3.2" fill="${variant === 'white' ? '#000000' : '#ffffff'}"/>
        <circle cx="32" cy="30" r="3.2" fill="${variant === 'white' ? '#000000' : '#ffffff'}"/>
        <circle cx="44" cy="30" r="3.2" fill="${variant === 'white' ? '#000000' : '#ffffff'}"/>
      </svg>
    `;

    const colorSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3B82F6"/>
            <stop offset="100%" stop-color="#2563EB"/>
          </linearGradient>
        </defs>
        <path fill="url(#g)" d="M10 12c-3.3 0-6 2.7-6 6v23c0 3.3 2.7 6 6 6h9.2l11 8.2c1 .7 2.3-.1 2.3-1.4V47H54c3.3 0 6-2.7 6-6V18c0-3.3-2.7-6-6-6H10z"/>
        <circle cx="20" cy="30" r="3.2" fill="#ffffff"/>
        <circle cx="32" cy="30" r="3.2" fill="#ffffff"/>
        <circle cx="44" cy="30" r="3.2" fill="#ffffff"/>
      </svg>
    `;

    const svg = process.platform === 'darwin' ? monochromeSvg : colorSvg;
    const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return nativeImage.createFromDataURL(dataUrl);
  }
}
