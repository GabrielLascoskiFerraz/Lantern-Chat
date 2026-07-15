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
  LockClosed20Regular,
  Person20Regular
} from '@fluentui/react-icons';
import { ipcClient, Profile, StartupSettings } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { isProfileColor } from './profileIdentityOptions';
import {
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
  onThemeModeChange: (mode: ThemeMode) => void;
  fontSizeMode: FontSizeMode;
  onFontSizeModeChange: (mode: FontSizeMode) => void;
  onClose: () => void;
  onSave: (payload: {
    profile: {
      displayName: string;
      avatarEmoji: string;
      avatarBg: string;
      statusMessage: string;
    };
    startup: {
      openAtLogin: boolean;
      downloadsDir: string;
      doNotDisturbUntil: number;
    };
  }) => Promise<void>;
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

const STATUS_PRESETS = ['Disponível', 'Em reunião', 'Foco total', 'Volto já', 'Não perturbe'];

export const SettingsModal = ({
  open,
  profile,
  startupSettings,
  themeMode,
  onThemeModeChange,
  fontSizeMode,
  onFontSizeModeChange,
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
  const [passwordExpanded, setPasswordExpanded] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState('');
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState('');

  const resetDraftFromProps = (): void => {
    setActiveSection('profile');
    setDisplayName(profile.displayName);
    setStatusMessage(profile.statusMessage);
    setAvatarEmoji(profile.avatarEmoji);
    setAvatarBg(profile.avatarBg);
    setOpenAtLogin(Boolean(startupSettings?.openAtLogin));
    setDownloadsDir(startupSettings?.downloadsDir || '');
    setDoNotDisturbUntil(Number(startupSettings?.doNotDisturbUntil || 0));
    setPasswordExpanded(false);
    setCurrentPassword('');
    setNewPassword('');
    setNewPasswordConfirm('');
    setPasswordFeedback('');
    setPasswordChanged(false);
    setPasswordBusy(false);
    setSaveBusy(false);
    setSaveFeedback('');
  };

  useEffect(() => {
    if (open) resetDraftFromProps();
  }, [open, profile, startupSettings]);

  const activeDoNotDisturbUntil = doNotDisturbUntil > Date.now() ? doNotDisturbUntil : 0;
  const doNotDisturbLabel = activeDoNotDisturbUntil
    ? `Ativo até ${new Date(activeDoNotDisturbUntil).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : 'Desativado';

  const hasChanges = useMemo(
    () =>
      displayName !== profile.displayName ||
      statusMessage !== profile.statusMessage ||
      avatarEmoji !== profile.avatarEmoji ||
      avatarBg.toLowerCase() !== profile.avatarBg.toLowerCase() ||
      openAtLogin !== Boolean(startupSettings?.openAtLogin) ||
      downloadsDir !== (startupSettings?.downloadsDir || '') ||
      doNotDisturbUntil !== Number(startupSettings?.doNotDisturbUntil || 0),
    [
      avatarBg,
      avatarEmoji,
      displayName,
      doNotDisturbUntil,
      downloadsDir,
      openAtLogin,
      profile,
      startupSettings,
      statusMessage
    ]
  );

  const requestClose = (): void => {
    if (saveBusy || passwordBusy) return;
    if (hasChanges && !window.confirm('Descartar as alterações feitas nas configurações?')) return;
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
        profile: {
          displayName: displayName.trim() || profile.displayName,
          avatarEmoji: avatarEmoji.trim() || profile.avatarEmoji,
          avatarBg: isProfileColor(avatarBg) ? avatarBg.trim() : profile.avatarBg,
          statusMessage: statusMessage.trim() || 'Disponível'
        },
        startup: {
          openAtLogin,
          downloadsDir: downloadsDir.trim() || (startupSettings?.downloadsDir || ''),
          doNotDisturbUntil: activeDoNotDisturbUntil
        }
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

  return (
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
                  <div className="settings-card settings-option-card">
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
                  </div>
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
                        <p>Escolha a aparência do Lantern. A alteração é aplicada imediatamente neste dispositivo.</p>
                      </div>
                      <span className="settings-state-pill">{themeModeLabel(themeMode)}</span>
                    </div>
                    <ThemeSelector value={themeMode} onChange={onThemeModeChange} />
                  </div>
                  <div className="settings-card settings-option-card settings-font-card">
                    <div className="settings-option-heading">
                      <div>
                        <h3>Tamanho da fonte</h3>
                        <p>Ajuste a escala dos textos e controles para este dispositivo.</p>
                      </div>
                      <span className="settings-state-pill">{fontSizeModeLabel(fontSizeMode)}</span>
                    </div>
                    <FontSizeSelector value={fontSizeMode} onChange={onFontSizeModeChange} />
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
                </section>
              )}

              {activeSection === 'security' && (
                <section aria-labelledby="settings-security-title">
                  <header className="settings-section-heading">
                    <div>
                      <h2 id="settings-security-title">Segurança</h2>
                      <p>Atualize a senha usada para acessar sua conta.</p>
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
                </section>
              )}
            </div>
          </DialogContent>

          <DialogActions className="settings-actions">
            <div className="settings-actions-feedback" aria-live="polite">
              {saveFeedback || (hasChanges ? 'As alterações ainda não foram salvas.' : 'Tudo atualizado.')}
            </div>
            <Button appearance="secondary" disabled={saveBusy || passwordBusy} onClick={requestClose}>Cancelar</Button>
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
  );
};
