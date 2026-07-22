import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Spinner,
  Switch,
  Text
} from '@fluentui/react-components';
import {
  Alert20Regular,
  Apps20Regular,
  ArrowSync20Regular,
  Delete20Regular,
  Desktop20Regular,
  LockClosed20Regular,
  Person20Regular,
  PlugConnected20Regular
} from '@fluentui/react-icons';
import {
  AccountSession,
  ClientAuthState,
  ipcClient,
  LocalStorageClearTarget,
  LocalStorageUsage,
  Profile,
  RelaySettings,
  StartupSettings
} from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { isProfileColor } from './profileIdentityOptions';
import {
  DensityMode,
  DensitySelector,
  densityModeLabel,
  FontSizeMode,
  FontSizeSelector,
  fontSizeModeLabel,
  ThemeMode,
  ThemeSelector,
  themeModeLabel
} from './AppearancePreferences';

interface SettingsModalProps {
  open: boolean;
  profile: Profile;
  startupSettings: StartupSettings | null;
  themeMode: ThemeMode;
  fontSizeMode: FontSizeMode;
  densityMode: DensityMode;
  onAppearancePreview: (appearance: AppearanceSettings) => void;
  onClose: () => void;
  onSave: (payload: {
    profile?: {
      displayName: string;
      avatarEmoji: string;
      avatarBg: string;
      statusMessage: string;
    };
    startup?: {
      openAtLogin: boolean;
      downloadsDir: string;
      doNotDisturbUntil: number;
    };
    appearance?: AppearanceSettings;
  }) => Promise<void>;
}

interface AppearanceSettings {
  themeMode: ThemeMode;
  fontSizeMode: FontSizeMode;
  densityMode: DensityMode;
}

interface SettingsBaseline extends AppearanceSettings {
  displayName: string;
  statusMessage: string;
  avatarEmoji: string;
  avatarBg: string;
  openAtLogin: boolean;
  downloadsDir: string;
  doNotDisturbUntil: number;
}

type SettingsSection = 'profile' | 'notifications' | 'application' | 'security';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  icon: typeof Person20Regular;
  label: string;
  description: string;
}> = [
  { id: 'profile', icon: Person20Regular, label: 'Perfil', description: 'Nome, status e identidade visual' },
  { id: 'notifications', icon: Alert20Regular, label: 'Notificações', description: 'Silêncio e avisos do aplicativo' },
  { id: 'application', icon: Apps20Regular, label: 'Aplicativo', description: 'Inicialização e arquivos recebidos' },
  { id: 'security', icon: LockClosed20Regular, label: 'Segurança', description: 'Senha e acesso à conta' }
];

const STATUS_PRESETS = ['Disponível', 'Em reunião', 'Foco total', 'Volto já'];

const formatStorageSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
};

export const SettingsModal = ({
  open,
  profile,
  startupSettings,
  themeMode,
  fontSizeMode,
  densityMode,
  onAppearancePreview,
  onClose,
  onSave
}: SettingsModalProps) => {
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [statusMessage, setStatusMessage] = useState(profile.statusMessage);
  const [avatarEmoji, setAvatarEmoji] = useState(profile.avatarEmoji);
  const [avatarBg, setAvatarBg] = useState(profile.avatarBg);
  const [openAtLogin, setOpenAtLogin] = useState(Boolean(startupSettings?.openAtLogin));
  const [downloadsDir, setDownloadsDir] = useState(startupSettings?.downloadsDir || '');
  const [doNotDisturbUntil, setDoNotDisturbUntil] = useState(
    Number(startupSettings?.doNotDisturbUntil || 0)
  );
  const [draftThemeMode, setDraftThemeMode] = useState(themeMode);
  const [draftFontSizeMode, setDraftFontSizeMode] = useState(fontSizeMode);
  const [draftDensityMode, setDraftDensityMode] = useState(densityMode);
  const [baseline, setBaseline] = useState<SettingsBaseline>(() => ({
    displayName: profile.displayName,
    statusMessage: profile.statusMessage,
    avatarEmoji: profile.avatarEmoji,
    avatarBg: profile.avatarBg,
    openAtLogin: Boolean(startupSettings?.openAtLogin),
    downloadsDir: startupSettings?.downloadsDir || '',
    doNotDisturbUntil: Number(startupSettings?.doNotDisturbUntil || 0),
    themeMode,
    fontSizeMode,
    densityMode
  }));
  const [passwordExpanded, setPasswordExpanded] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState('');
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');
  const [updateSupported, setUpdateSupported] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState('');
  const [accountSessions, setAccountSessions] = useState<AccountSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [pendingSessionRevoke, setPendingSessionRevoke] = useState<AccountSession | null>(null);
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false);
  const [relayConnection, setRelayConnection] = useState<{
    settings: RelaySettings;
    auth: ClientAuthState;
  } | null>(null);
  const [relayConnectionLoading, setRelayConnectionLoading] = useState(false);
  const [relayConnectionError, setRelayConnectionError] = useState('');
  const [storageUsage, setStorageUsage] = useState<LocalStorageUsage | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [storageClearTarget, setStorageClearTarget] = useState<LocalStorageClearTarget | null>(null);
  const [storageClearBusy, setStorageClearBusy] = useState(false);

  const resetDraftFromProps = (): void => {
    const nextBaseline: SettingsBaseline = {
      displayName: profile.displayName,
      statusMessage: profile.statusMessage,
      avatarEmoji: profile.avatarEmoji,
      avatarBg: profile.avatarBg,
      openAtLogin: Boolean(startupSettings?.openAtLogin),
      downloadsDir: startupSettings?.downloadsDir || '',
      doNotDisturbUntil: Number(startupSettings?.doNotDisturbUntil || 0),
      themeMode,
      fontSizeMode,
      densityMode
    };
    setBaseline(nextBaseline);
    setActiveSection('profile');
    setDisplayName(nextBaseline.displayName);
    setStatusMessage(nextBaseline.statusMessage);
    setAvatarEmoji(nextBaseline.avatarEmoji);
    setAvatarBg(nextBaseline.avatarBg);
    setOpenAtLogin(nextBaseline.openAtLogin);
    setDownloadsDir(nextBaseline.downloadsDir);
    setDoNotDisturbUntil(nextBaseline.doNotDisturbUntil);
    setDraftThemeMode(nextBaseline.themeMode);
    setDraftFontSizeMode(nextBaseline.fontSizeMode);
    setDraftDensityMode(nextBaseline.densityMode);
    setPasswordExpanded(false);
    setCurrentPassword('');
    setNewPassword('');
    setNewPasswordConfirm('');
    setPasswordFeedback('');
    setPasswordChanged(false);
    setPasswordBusy(false);
    setSaveBusy(false);
    setSaveFeedback('');
    setAccountSessions([]);
    setSessionsError('');
    setSessionsLoading(false);
    setRevokingSessionId(null);
    setPendingSessionRevoke(null);
    setDiscardConfirmationOpen(false);
    setRelayConnection(null);
    setRelayConnectionError('');
    setRelayConnectionLoading(false);
    setStorageUsage(null);
    setStorageLoading(false);
    setStorageError('');
    setStorageClearTarget(null);
    setStorageClearBusy(false);
  };

  useEffect(() => {
    if (open) {
      resetDraftFromProps();
      void ipcClient.getUpdateState().then((state) => setUpdateSupported(state.supported)).catch(() => setUpdateSupported(false));
    }
  }, [open]);

  useEffect(() => {
    if (!open || activeSection !== 'security') return;
    setSessionsLoading(true);
    setSessionsError('');
    const refresh = (initial = false): void => {
      void ipcClient.listAccountSessions()
        .then((sessions) => {
          setAccountSessions(sessions);
          setSessionsError('');
        })
        .catch((error) => {
          if (!initial) return;
          const raw = error instanceof Error ? error.message : 'Não foi possível carregar as sessões.';
          setSessionsError(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
        })
        .finally(() => initial && setSessionsLoading(false));
    };
    refresh(true);
    const timer = window.setInterval(() => refresh(false), 10_000);
    return () => window.clearInterval(timer);
  }, [activeSection, open]);

  const refreshRelayConnection = (): void => {
    setRelayConnectionLoading(true);
    setRelayConnectionError('');
    void Promise.all([ipcClient.getRelaySettings(), ipcClient.getAuthState()])
      .then(([settings, auth]) => setRelayConnection({ settings, auth }))
      .catch((error) => {
        const raw = error instanceof Error ? error.message : 'Não foi possível consultar a conexão.';
        setRelayConnectionError(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
      })
      .finally(() => setRelayConnectionLoading(false));
  };

  const refreshStorageUsage = (): void => {
    setStorageLoading(true);
    setStorageError('');
    void ipcClient.getLocalStorageUsage()
      .then(setStorageUsage)
      .catch((error) => {
        const raw = error instanceof Error ? error.message : 'Não foi possível calcular o espaço utilizado.';
        setStorageError(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
      })
      .finally(() => setStorageLoading(false));
  };

  useEffect(() => {
    if (!open || activeSection !== 'application') return;
    refreshRelayConnection();
    refreshStorageUsage();
  }, [activeSection, open]);

  const confirmStorageClear = (): void => {
    if (!storageClearTarget || storageClearBusy) return;
    const target = storageClearTarget;
    setStorageClearBusy(true);
    setStorageError('');
    void ipcClient.clearLocalStorage(target)
      .then((usage) => {
        setStorageUsage(usage);
        setStorageClearTarget(null);
      })
      .catch((error) => {
        const raw = error instanceof Error ? error.message : 'Não foi possível concluir a limpeza.';
        setStorageError(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
        setStorageClearTarget(null);
      })
      .finally(() => setStorageClearBusy(false));
  };

  const relayEndpoint = relayConnection?.settings.endpoint || relayConnection?.auth.endpoint || null;
  let relayEndpointDetails: { protocol: string; host: string; port: string } | null = null;
  if (relayEndpoint) {
    try {
      const parsed = new URL(relayEndpoint);
      relayEndpointDetails = {
        protocol: parsed.protocol === 'wss:' ? 'WSS (segura)' : 'WS (local simples)',
        host: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'wss:' ? '443' : '80')
      };
    } catch {
      relayEndpointDetails = null;
    }
  }

  const relayConnectionModeLabel = relayConnection?.auth.relay.mode === 'local-auto'
    ? 'Local automático'
    : relayConnection?.auth.relay.mode === 'local-manual'
      ? 'Local manual'
      : 'Externo';

  const activeDoNotDisturbUntil = doNotDisturbUntil > Date.now() ? doNotDisturbUntil : 0;
  const doNotDisturbLabel = activeDoNotDisturbUntil
    ? `Ativo até ${new Date(activeDoNotDisturbUntil).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : 'Desativado';

  const profileHasChanges = useMemo(
    () =>
      displayName !== baseline.displayName ||
      statusMessage !== baseline.statusMessage ||
      avatarEmoji !== baseline.avatarEmoji ||
      avatarBg.toLowerCase() !== baseline.avatarBg.toLowerCase(),
    [
      avatarBg,
      avatarEmoji,
      baseline,
      displayName,
      statusMessage
    ]
  );
  const startupHasChanges = useMemo(
    () =>
      openAtLogin !== baseline.openAtLogin ||
      downloadsDir !== baseline.downloadsDir ||
      doNotDisturbUntil !== baseline.doNotDisturbUntil,
    [baseline, doNotDisturbUntil, downloadsDir, openAtLogin]
  );
  const appearanceHasChanges =
    draftThemeMode !== baseline.themeMode ||
    draftFontSizeMode !== baseline.fontSizeMode ||
    draftDensityMode !== baseline.densityMode;
  const hasChanges = profileHasChanges || startupHasChanges || appearanceHasChanges;

  const previewAppearance = (next: Partial<AppearanceSettings>): void => {
    const appearance: AppearanceSettings = {
      themeMode: next.themeMode ?? draftThemeMode,
      fontSizeMode: next.fontSizeMode ?? draftFontSizeMode,
      densityMode: next.densityMode ?? draftDensityMode
    };
    setDraftThemeMode(appearance.themeMode);
    setDraftFontSizeMode(appearance.fontSizeMode);
    setDraftDensityMode(appearance.densityMode);
    onAppearancePreview(appearance);
  };

  const restoreAppearancePreview = (): void => {
    onAppearancePreview({
      themeMode: baseline.themeMode,
      fontSizeMode: baseline.fontSizeMode,
      densityMode: baseline.densityMode
    });
  };

  const requestClose = (): void => {
    if (saveBusy || passwordBusy) return;
    if (hasChanges) {
      setDiscardConfirmationOpen(true);
      return;
    }
    onClose();
  };

  const setDoNotDisturbFor = (milliseconds: number): void => {
    setDoNotDisturbUntil(Date.now() + milliseconds);
  };

  const setDoNotDisturbUntilTomorrow = (): void => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    setDoNotDisturbUntil(tomorrow.getTime());
  };

  const save = async (): Promise<void> => {
    if (!hasChanges || saveBusy) return;
    setSaveBusy(true);
    setSaveFeedback('');
    try {
      await onSave({
        profile: profileHasChanges
          ? {
              displayName: displayName.trim() || baseline.displayName,
              avatarEmoji: avatarEmoji.trim() || baseline.avatarEmoji,
              avatarBg: isProfileColor(avatarBg) ? avatarBg.trim() : baseline.avatarBg,
              statusMessage: statusMessage.trim() || 'Disponível'
            }
          : undefined,
        startup: startupHasChanges
          ? {
              openAtLogin,
              downloadsDir: downloadsDir.trim() || baseline.downloadsDir,
              doNotDisturbUntil: activeDoNotDisturbUntil
            }
          : undefined,
        appearance: appearanceHasChanges
          ? {
              themeMode: draftThemeMode,
              fontSizeMode: draftFontSizeMode,
              densityMode: draftDensityMode
            }
          : undefined
      });
    } catch (error) {
      setSaveFeedback(error instanceof Error ? error.message : 'Não foi possível salvar as configurações.');
    } finally {
      setSaveBusy(false);
    }
  };

  const changePassword = (): void => {
    setPasswordBusy(true);
    setPasswordFeedback('');
    setPasswordChanged(false);
    void ipcClient.changePassword({ currentPassword, newPassword })
      .then(() => {
        setCurrentPassword('');
        setNewPassword('');
        setNewPasswordConfirm('');
        setPasswordChanged(true);
        setPasswordFeedback('Senha alterada com sucesso. As outras sessões foram encerradas.');
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setPasswordFeedback(
          message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
        );
      })
      .finally(() => setPasswordBusy(false));
  };

  const revokeSession = (session: AccountSession): void => {
    setPendingSessionRevoke(session);
  };

  const confirmSessionRevoke = (): void => {
    const session = pendingSessionRevoke;
    if (!session) return;
    setPendingSessionRevoke(null);
    setRevokingSessionId(session.sessionId);
    setSessionsError('');
    void ipcClient.revokeAccountSession(session.sessionId)
      .then((result) => {
        if (!result.revoked) throw new Error('A sessão já havia sido encerrada ou expirou.');
        if (!result.current) {
          setAccountSessions((current) => current.filter((item) => item.sessionId !== session.sessionId));
        }
      })
      .catch((error) => {
        const raw = error instanceof Error ? error.message : 'Não foi possível encerrar a sessão.';
        setSessionsError(raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
      })
      .finally(() => setRevokingSessionId(null));
  };

  const formatSessionDate = (value: number): string => new Date(value).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  });

  return (
    <>
    <Dialog open={open} onOpenChange={(_, data) => !data.open && requestClose()}>
      <DialogSurface className="settings-modal">
        <DialogBody>
          <DialogTitle>
            <div className="settings-title-row">
              <div>
                <span>Configurações</span>
                <Text size={200}>Personalize o Lantern neste dispositivo.</Text>
              </div>
              {hasChanges && <span className="settings-pending-badge" role="status">Alterações pendentes</span>}
            </div>
          </DialogTitle>

          <DialogContent className="settings-content">
            <nav className="settings-navigation" aria-label="Seções das configurações">
              {SETTINGS_SECTIONS.map((section) => {
                const SectionIcon = section.icon;
                return (
                  <button
                    key={section.id}
                    type="button"
                    className={activeSection === section.id ? 'active' : ''}
                    aria-current={activeSection === section.id ? 'page' : undefined}
                    onClick={() => setActiveSection(section.id)}
                  >
                    <span className="settings-navigation-icon" aria-hidden="true">
                      <SectionIcon />
                    </span>
                    <span>
                      <strong>{section.label}</strong>
                      <small>{section.description}</small>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="settings-section-panel">
              {activeSection === 'profile' && (
                <section aria-labelledby="settings-profile-title">
                  <header className="settings-section-heading">
                    <div>
                      <h2 id="settings-profile-title">Perfil</h2>
                      <p>Estas informações acompanham sua conta em todos os dispositivos.</p>
                    </div>
                  </header>

                  <div className="settings-profile-layout">
                    <aside className="settings-preview-card" aria-label="Prévia do perfil">
                      <span className="settings-preview-eyebrow">PRÉVIA</span>
                      <Avatar emoji={avatarEmoji} bg={avatarBg} size={116} />
                      <Text weight="semibold" size={500}>{displayName.trim() || profile.displayName}</Text>
                      <Text size={300}>{statusMessage.trim() || 'Disponível'}</Text>
                      <Text size={200} className="settings-profile-id">ID {profile.deviceId.slice(0, 12)}</Text>
                      {profile.username?.trim() && (
                        <Text size={200} className="settings-profile-username">
                          @{profile.username.trim().replace(/^@+/, '')}
                        </Text>
                      )}
                    </aside>

                    <div className="settings-profile-form">
                      <div className="settings-card settings-basic-profile-card">
                        <Field label="Nome de exibição">
                          <Input
                            value={displayName}
                            maxLength={80}
                            onChange={(_, data) => setDisplayName(data.value)}
                          />
                        </Field>
                        <Field label="Mensagem de status">
                          <Input
                            value={statusMessage}
                            onChange={(_, data) => setStatusMessage(data.value)}
                            placeholder="Ex.: Em reunião, respondo depois"
                            maxLength={120}
                          />
                          <div className="status-presets" aria-label="Sugestões de status">
                            {STATUS_PRESETS.map((preset) => (
                              <button
                                type="button"
                                key={preset}
                                aria-pressed={statusMessage.trim() === preset}
                                className={`status-chip ${statusMessage.trim() === preset ? 'active' : ''}`}
                                onClick={() => setStatusMessage(preset)}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        </Field>
                      </div>

                      <ProfileIdentityEditor
                        emoji={avatarEmoji}
                        color={avatarBg}
                        onEmojiChange={setAvatarEmoji}
                        onColorChange={setAvatarBg}
                      />
                    </div>
                  </div>
                </section>
              )}

              {activeSection === 'notifications' && (
                <section aria-labelledby="settings-notifications-title">
                  <header className="settings-section-heading">
                    <div>
                      <h2 id="settings-notifications-title">Notificações</h2>
                      <p>Controle quando o Lantern pode chamar sua atenção.</p>
                    </div>
                  </header>
                  {startupSettings?.downloadsDir && <div className="settings-card settings-option-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Não perturbe</h3>
                        <p>Silencia notificações nativas e sons pelo período escolhido.</p>
                      </div>
                      <span className={`settings-state-pill ${activeDoNotDisturbUntil ? 'enabled' : ''}`}>
                        {doNotDisturbLabel}
                      </span>
                    </div>
                    <div className="settings-dnd-actions">
                      <Button appearance="secondary" onClick={() => setDoNotDisturbFor(15 * 60 * 1000)}>15 minutos</Button>
                      <Button appearance="secondary" onClick={() => setDoNotDisturbFor(60 * 60 * 1000)}>1 hora</Button>
                      <Button appearance="secondary" onClick={setDoNotDisturbUntilTomorrow}>Até amanhã</Button>
                      {activeDoNotDisturbUntil > 0 && (
                        <Button appearance="subtle" onClick={() => setDoNotDisturbUntil(0)}>Desativar</Button>
                      )}
                    </div>
                  </div>}
                </section>
              )}

              {activeSection === 'application' && (
                <section aria-labelledby="settings-application-title">
                  <header className="settings-section-heading">
                    <div>
                      <h2 id="settings-application-title">Aplicativo</h2>
                      <p>Preferências que valem somente para este dispositivo.</p>
                    </div>
                  </header>
                  <div className="settings-card settings-option-card settings-theme-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Tema do aplicativo</h3>
                        <p>Visualize a aparência do Lantern e confirme no botão Salvar alterações.</p>
                      </div>
                      <span className="settings-state-pill">{themeModeLabel(draftThemeMode)}</span>
                    </div>
                    <ThemeSelector value={draftThemeMode} onChange={(mode) => previewAppearance({ themeMode: mode })} />
                  </div>
                  <div className="settings-card settings-option-card settings-font-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Tamanho da fonte</h3>
                        <p>Ajuste a escala dos textos e controles para este dispositivo.</p>
                      </div>
                      <span className="settings-state-pill">{fontSizeModeLabel(draftFontSizeMode)}</span>
                    </div>
                    <FontSizeSelector value={draftFontSizeMode} onChange={(mode) => previewAppearance({ fontSizeMode: mode })} />
                  </div>
                  <div className="settings-card settings-option-card settings-density-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Densidade da interface</h3>
                        <p>Ajuste o espaçamento entre listas, controles e áreas de conteúdo neste dispositivo.</p>
                      </div>
                      <span className="settings-state-pill">{densityModeLabel(draftDensityMode)}</span>
                    </div>
                    <DensitySelector value={draftDensityMode} onChange={(mode) => previewAppearance({ densityMode: mode })} />
                  </div>
                  <div className="settings-card settings-option-card">
                    <div className="settings-switch-row">
                      <div>
                        <h3>Abrir o Lantern ao iniciar o sistema</h3>
                        <p>Inicia o aplicativo automaticamente depois que você entra no computador.</p>
                      </div>
                      <Switch
                        checked={openAtLogin}
                        disabled={!startupSettings?.supported}
                        onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))}
                        aria-label="Abrir o Lantern ao iniciar o sistema"
                      />
                    </div>
                    {!startupSettings?.supported && (
                      <Text size={200} className="settings-inline-help">Esta opção não é suportada neste sistema.</Text>
                    )}
                  </div>
                  {updateSupported && (
                    <div className="settings-card settings-option-card">
                      <div className="settings-option-heading">
                        <div>
                          <h3>Atualização do aplicativo</h3>
                          <p>Verifica novamente o Relay e reinstala a versão disponibilizada para este sistema.</p>
                        </div>
                        <Button
                          appearance="secondary"
                          icon={<ArrowSync20Regular />}
                          disabled={updateBusy}
                          onClick={() => {
                            setUpdateBusy(true);
                            setUpdateFeedback('Verificando atualização…');
                            void ipcClient.forceUpdate().then((state) => {
                              setUpdateFeedback(state.status === 'idle'
                                ? 'O Relay não possui um instalador compatível para este sistema.'
                                : 'O download da atualização foi iniciado.');
                            }).catch((error) => {
                              setUpdateFeedback(error instanceof Error ? error.message : 'Não foi possível verificar a atualização.');
                            }).finally(() => setUpdateBusy(false));
                          }}
                        >
                          Forçar atualização
                        </Button>
                      </div>
                      {updateFeedback && <Text size={200} className="settings-inline-help">{updateFeedback}</Text>}
                    </div>
                  )}
                  <div className="settings-card settings-option-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Pasta de arquivos recebidos</h3>
                        <p>Os novos anexos baixados neste dispositivo serão salvos nessa pasta.</p>
                      </div>
                    </div>
                    <div className="settings-directory-row">
                      <Input
                        value={downloadsDir}
                        onChange={(_, data) => setDownloadsDir(data.value)}
                        placeholder="Selecione a pasta para arquivos recebidos"
                        aria-label="Pasta de arquivos recebidos"
                      />
                      <Button
                        appearance="secondary"
                        onClick={() =>
                          void ipcClient.pickDirectory(downloadsDir).then((folder) => {
                            if (folder) setDownloadsDir(folder);
                          })
                        }
                      >
                        Escolher pasta
                      </Button>
                    </div>
                  </div>
                  <div className="settings-card settings-option-card settings-storage-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Armazenamento local</h3>
                        <p>Libere espaço deste dispositivo sem apagar mensagens ou dados armazenados no Relay.</p>
                      </div>
                    </div>
                    <div className="settings-storage-list">
                      <div className="settings-storage-row">
                        <div>
                          <strong>Cache do aplicativo</strong>
                          <span>Recursos temporários da interface. Conversas e preferências são preservadas.</span>
                        </div>
                        <span className="settings-storage-size">{storageLoading && !storageUsage ? 'Calculando…' : formatStorageSize(storageUsage?.appCacheBytes || 0)}</span>
                        <Button
                          className="settings-storage-action"
                          appearance="secondary"
                          icon={<Delete20Regular />}
                          disabled={storageClearBusy || !storageUsage?.appCacheBytes}
                          onClick={() => setStorageClearTarget('app-cache')}
                        >
                          Limpar cache
                        </Button>
                      </div>
                      <div className="settings-storage-row">
                        <div>
                          <strong>Anexos do Lantern</strong>
                          <span>{storageUsage?.attachmentCount || 0} arquivo(s) baixado(s). Serão obtidos novamente sob demanda.</span>
                        </div>
                        <span className="settings-storage-size">{storageLoading && !storageUsage ? 'Calculando…' : formatStorageSize(storageUsage?.attachmentBytes || 0)}</span>
                        <Button
                          className="settings-storage-action"
                          appearance="secondary"
                          icon={<Delete20Regular />}
                          disabled={storageClearBusy || !storageUsage?.attachmentBytes}
                          onClick={() => setStorageClearTarget('attachments')}
                        >
                          Limpar anexos
                        </Button>
                      </div>
                    </div>
                    <div className="settings-storage-footer">
                      <span>Total liberável: <strong>{formatStorageSize(storageUsage?.totalBytes || 0)}</strong></span>
                      <Button
                        className="settings-storage-action settings-storage-clear-all"
                        appearance="primary"
                        icon={<Delete20Regular />}
                        disabled={storageClearBusy || !storageUsage?.totalBytes}
                        onClick={() => setStorageClearTarget('all')}
                      >
                        Limpar ambos
                      </Button>
                    </div>
                    {storageError && <Text className="settings-password-feedback" role="alert">{storageError}</Text>}
                  </div>
                  <div className="settings-card settings-option-card settings-relay-connection-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Conexão com o Relay</h3>
                        <p>Servidor utilizado para sincronizar sua conta, conversas e arquivos.</p>
                      </div>
                      <span className={`settings-state-pill ${relayConnection?.settings.connected ? 'enabled' : ''}`}>
                        {relayConnectionLoading && !relayConnection
                          ? 'Consultando...'
                          : relayConnection?.settings.connected ? 'Conectado' : 'Sem conexão'}
                      </span>
                    </div>
                    {relayConnectionError ? (
                      <Text className="settings-password-feedback" role="alert">{relayConnectionError}</Text>
                    ) : (
                      <div className="settings-relay-connection-body">
                        <div className={`settings-relay-connection-icon ${relayConnection?.settings.connected ? 'connected' : ''}`} aria-hidden="true">
                          <PlugConnected20Regular />
                        </div>
                        <dl className="settings-relay-details">
                          <div><dt>Endereço</dt><dd>{relayEndpoint || 'Nenhum Relay conectado'}</dd></div>
                          <div><dt>Tipo</dt><dd>{relayConnection ? relayConnectionModeLabel : '—'}</dd></div>
                          <div><dt>Protocolo</dt><dd>{relayEndpointDetails?.protocol || '—'}</dd></div>
                          <div><dt>Servidor</dt><dd>{relayEndpointDetails?.host || relayConnection?.settings.host || '—'}</dd></div>
                          <div><dt>Porta</dt><dd>{relayEndpointDetails?.port || relayConnection?.settings.port || '—'}</dd></div>
                        </dl>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {activeSection === 'security' && (
                <section aria-labelledby="settings-security-title">
                  <header className="settings-section-heading">
                    <div>
                      <h2 id="settings-security-title">Segurança</h2>
                      <p>Gerencie sua senha e os dispositivos conectados à conta.</p>
                    </div>
                  </header>
                  <div className="settings-card settings-option-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Senha da conta</h3>
                        <p>Ao alterar a senha, suas outras sessões serão encerradas.</p>
                      </div>
                      {!passwordExpanded && (
                        <Button appearance="secondary" onClick={() => setPasswordExpanded(true)}>Alterar senha</Button>
                      )}
                    </div>
                    {passwordExpanded && (
                      <div className="settings-password-panel">
                        <Field label="Senha atual">
                          <Input
                            type="password"
                            value={currentPassword}
                            onChange={(_, data) => setCurrentPassword(data.value)}
                            autoComplete="current-password"
                          />
                        </Field>
                        <Field label="Nova senha" hint="Use pelo menos 10 caracteres.">
                          <Input
                            type="password"
                            value={newPassword}
                            onChange={(_, data) => setNewPassword(data.value)}
                            autoComplete="new-password"
                          />
                        </Field>
                        <Field label="Confirmar nova senha">
                          <Input
                            type="password"
                            value={newPasswordConfirm}
                            onChange={(_, data) => setNewPasswordConfirm(data.value)}
                            autoComplete="new-password"
                          />
                        </Field>
                        {passwordFeedback && (
                          <Text
                            size={200}
                            className={`settings-password-feedback ${passwordChanged ? 'success' : ''}`}
                            role={passwordChanged ? 'status' : 'alert'}
                          >
                            {passwordFeedback}
                          </Text>
                        )}
                        <div className="settings-password-actions">
                          <Button
                            appearance="subtle"
                            disabled={passwordBusy}
                            onClick={() => {
                              setPasswordExpanded(false);
                              setCurrentPassword('');
                              setNewPassword('');
                              setNewPasswordConfirm('');
                              setPasswordFeedback('');
                              setPasswordChanged(false);
                            }}
                          >
                            Cancelar
                          </Button>
                          <Button
                            appearance="primary"
                            disabled={passwordBusy || !currentPassword || newPassword.length < 10 || newPassword !== newPasswordConfirm}
                            onClick={changePassword}
                          >
                            {passwordBusy ? <><Spinner size="tiny" /> Salvando...</> : 'Salvar nova senha'}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="settings-card settings-option-card settings-sessions-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Sessões da conta</h3>
                        <p>Dispositivos em que sua conta está conectada. Encerre qualquer acesso que você não reconheça.</p>
                      </div>
                      <Button
                        appearance="subtle"
                        icon={sessionsLoading ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
                        disabled={sessionsLoading}
                        onClick={() => {
                          setSessionsLoading(true);
                          setSessionsError('');
                          void ipcClient.listAccountSessions()
                            .then(setAccountSessions)
                            .catch((error) => setSessionsError(error instanceof Error ? error.message : 'Não foi possível atualizar as sessões.'))
                            .finally(() => setSessionsLoading(false));
                        }}
                      >
                        Atualizar
                      </Button>
                    </div>
                    {sessionsError && <Text className="settings-password-feedback" role="alert">{sessionsError}</Text>}
                    {sessionsLoading && accountSessions.length === 0 ? (
                      <div className="settings-sessions-state"><Spinner size="small" /><span>Carregando sessões...</span></div>
                    ) : accountSessions.length === 0 ? (
                      <div className="settings-sessions-state">Nenhuma sessão ativa encontrada.</div>
                    ) : (
                      <div className="settings-sessions-list">
                        {accountSessions.map((session) => (
                          <div className="settings-session-row" key={session.sessionId}>
                            <div className="settings-session-icon" aria-hidden="true"><Desktop20Regular /></div>
                            <div className="settings-session-info">
                              <div className="settings-session-title">
                                <strong>{session.current ? 'Este dispositivo' : 'Outro dispositivo'}</strong>
                                {session.current && <span className="settings-state-pill enabled">Sessão atual</span>}
                                {!session.current && (
                                  <span className={`settings-state-pill settings-session-activity ${session.active ? 'enabled' : ''}`}>
                                    <span className="settings-session-activity-dot" aria-hidden="true" />
                                    {session.active ? 'Ativa agora' : 'Sem conexão'}
                                  </span>
                                )}
                              </div>
                              <span>Identificador {session.deviceId.slice(0, 12)}</span>
                              <span>Atividade: {formatSessionDate(session.lastSeenAt)} · Login: {formatSessionDate(session.createdAt)}</span>
                              <span>Expira em {formatSessionDate(session.expiresAt)}</span>
                            </div>
                            <Button
                              appearance="secondary"
                              disabled={revokingSessionId !== null}
                              onClick={() => revokeSession(session)}
                            >
                              {revokingSessionId === session.sessionId
                                ? <><Spinner size="tiny" /> Encerrando...</>
                                : 'Encerrar sessão'}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          </DialogContent>

          <DialogActions className="settings-actions">
            <div className="settings-actions-feedback" aria-live="polite">
              {saveFeedback || (hasChanges
                ? 'As alterações ainda não foram salvas.'
                : 'Nenhuma alteração pendente.')}
            </div>
            <Button appearance="secondary" disabled={saveBusy || passwordBusy} onClick={requestClose}>
              {hasChanges ? 'Cancelar' : 'Fechar'}
            </Button>
            <Button
              className="settings-save-btn"
              appearance="primary"
              disabled={!hasChanges || saveBusy || !isProfileColor(avatarBg)}
              onClick={() => void save()}
            >
              {saveBusy ? <><Spinner size="tiny" /> Salvando...</> : 'Salvar alterações'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
    <ConfirmDialog
      open={Boolean(storageClearTarget)}
      title={storageClearTarget === 'all'
        ? 'Limpar cache e anexos?'
        : storageClearTarget === 'attachments' ? 'Limpar anexos locais?' : 'Limpar cache do aplicativo?'}
      description={storageClearTarget === 'attachments' || storageClearTarget === 'all'
        ? 'As cópias locais dos anexos serão removidas e baixadas novamente do Relay quando você precisar. Mensagens, conversas e dados da conta serão preservados.'
        : 'Somente recursos temporários da interface serão removidos. Mensagens, anexos e preferências serão preservados.'}
      confirmLabel={storageClearBusy ? 'Limpando…' : 'Limpar agora'}
      onCancel={() => !storageClearBusy && setStorageClearTarget(null)}
      onConfirm={confirmStorageClear}
    />
    <ConfirmDialog
      open={discardConfirmationOpen}
      title="Descartar alterações?"
      description="As alterações ainda não salvas serão perdidas e a prévia de aparência será restaurada."
      confirmLabel="Descartar"
      onCancel={() => setDiscardConfirmationOpen(false)}
      onConfirm={() => {
        setDiscardConfirmationOpen(false);
        restoreAppearancePreview();
        onClose();
      }}
    />
    <ConfirmDialog
      open={Boolean(pendingSessionRevoke)}
      title={pendingSessionRevoke?.current ? 'Encerrar esta sessão?' : 'Encerrar sessão?'}
      description={pendingSessionRevoke?.current
        ? 'Você será desconectado do Lantern neste dispositivo e precisará entrar novamente.'
        : 'A conta será desconectada daquele dispositivo imediatamente.'}
      confirmLabel="Encerrar sessão"
      onCancel={() => setPendingSessionRevoke(null)}
      onConfirm={confirmSessionRevoke}
    />
    </>
  );
};
