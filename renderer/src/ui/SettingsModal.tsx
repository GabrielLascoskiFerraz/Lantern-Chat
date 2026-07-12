import { useEffect, useState } from 'react';
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
  Switch,
  Text
} from '@fluentui/react-components';
import { ipcClient, LanguageSettings, Profile, RelaySettings, StartupSettings } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { useI18n } from '../i18n';

interface SettingsModalProps {
  open: boolean;
  profile: Profile;
  relaySettings: RelaySettings | null;
  startupSettings: StartupSettings | null;
  languageSettings: LanguageSettings | null;
  onForceRelayRediscovery: () => Promise<void>;
  onClose: () => void;
  onSave: (payload: {
    profile: {
      displayName: string;
      avatarEmoji: string;
      avatarBg: string;
      statusMessage: string;
    };
    relay: {
      automatic: boolean;
      host?: string;
      port?: number;
    };
    startup: {
      openAtLogin: boolean;
      downloadsDir: string;
      doNotDisturbUntil: number;
    };
    languageMode: LanguageSettings['mode'];
  }) => Promise<void>;
}

export const SettingsModal = ({
  open,
  profile,
  relaySettings,
  startupSettings,
  languageSettings,
  onForceRelayRediscovery,
  onClose,
  onSave
}: SettingsModalProps) => {
  const { t, locale } = useI18n();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [statusMessage, setStatusMessage] = useState(profile.statusMessage);
  const [avatarEmoji, setAvatarEmoji] = useState(profile.avatarEmoji);
  const [customEmoji, setCustomEmoji] = useState(profile.avatarEmoji);
  const [avatarBg, setAvatarBg] = useState(profile.avatarBg);
  const [relayAutomatic, setRelayAutomatic] = useState(relaySettings?.automatic ?? true);
  const [relayHost, setRelayHost] = useState(relaySettings?.host || '');
  const [relayPortDraft, setRelayPortDraft] = useState(String(relaySettings?.port || 43190));
  const [openAtLogin, setOpenAtLogin] = useState(Boolean(startupSettings?.openAtLogin));
  const [downloadsDir, setDownloadsDir] = useState(startupSettings?.downloadsDir || '');
  const [doNotDisturbUntil, setDoNotDisturbUntil] = useState(
    Number(startupSettings?.doNotDisturbUntil || 0)
  );
  const [languageMode, setLanguageMode] = useState<LanguageSettings['mode']>(
    languageSettings?.mode || 'auto'
  );
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [rediscoverBusy, setRediscoverBusy] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState('');
  const statusPresets = [
    { key: 'Available', value: 'Disponível' },
    { key: 'In a meeting', value: 'Em reunião' },
    { key: 'Focused', value: 'Foco total' },
    { key: 'Be right back', value: 'Volto já' },
    { key: 'Do not disturb', value: 'Não perturbe' }
  ];
  const emojiGroups = {
    rostos: [
      '🙂', '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '😉', '😍', '🥰',
      '😘', '😋', '😌', '😎', '🤓', '🧐', '🤠', '🥳', '🤩', '😴', '🤗', '🫡', '🫶', '🙌',
      '👏', '🤝', '🙏', '✨', '⭐', '🌟', '😏', '🤭', '🫢', '🤫', '🫠', '😶‍🌫️', '😬', '😮',
      '😯', '😲', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯', '🥵', '🥶', '🥴', '😵', '🤪',
      '😜', '😝', '🤤', '😷', '🤒', '🤕', '🤠', '🫨', '😶', '🫥', '🤐', '🤔', '🫣', '🫤',
      '😔', '😞', '☹️', '🙁', '😣', '😖', '😫', '😩', '😱', '😨', '😰', '😥', '😓'
    ],
    trabalho: [
      '🧠', '👩‍💻', '👨‍💻', '🧑‍💻', '🖥️', '⌨️', '🖱️', '🛠️', '🔧', '📚', '📖', '🧾',
      '📝', '📅', '📌', '📎', '📈', '📊', '📉', '🗂️', '🎯', '⏱️', '🚀', '⚡', '💡', '✅',
      '🔒', '🧭', '🧪', '🛰️', '🏢', '💼', '🗃️', '🗄️', '📁', '📂', '🧮', '📐', '📏', '🖇️',
      '🖊️', '🖋️', '✏️', '🧷', '📤', '📥', '📨', '📩', '📫', '📮', '📞', '☎️', '📱', '💻',
      '🧑‍🔬', '👩‍🔬', '👨‍🔬', '🧑‍🏫', '👩‍🏫', '👨‍🏫', '🧑‍💼', '👩‍💼', '👨‍💼', '🧑‍💼', '🏷️',
      '🛎️', '🔔', '📣', '📢', '📡', '🕹️', '🧯', '⚙️', '🪛', '🔩', '🧰'
    ],
    animais: [
      '🐶', '🐱', '🐰', '🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🐧', '🦄', '🐢', '🐬',
      '🐙', '🐳', '🦉', '🦋', '🐝', '🐞', '🐇', '🐈', '🐕', '🦝', '🦔', '🦦', '🦥', '🦜',
      '🦚', '🐿️', '🦌', '🦬', '🐺', '🐗', '🐴', '🫎', '🫏', '🐮', '🐷', '🐭', '🐹', '🐻',
      '🐻‍❄️', '🐔', '🐣', '🐤', '🦆', '🦢', '🦩', '🦤', '🦭', '🐡', '🐠', '🦈', '🐊', '🦎',
      '🐍', '🐉', '🦂', '🕷️', '🕸️', '🪲', '🪳', '🪰', '🪱', '🦗', '🐾', '🪿'
    ],
    comida: [
      '🍕', '🍔', '🍟', '🌭', '🌮', '🌯', '🍣', '🍜', '🍝', '🍱', '🥟', '🍗', '🥗', '🥪',
      '🍞', '🥐', '🍩', '🍪', '🧁', '🍰', '🍫', '🍿', '🍓', '🍉', '🍇', '🍍', '🥭', '🍒',
      '☕', '🧃', '🍎', '🍏', '🍐', '🍊', '🍋', '🍌', '🫐', '🥝', '🍅', '🥑', '🥦', '🥕',
      '🌽', '🥔', '🍠', '🥒', '🫑', '🧅', '🧄', '🍄', '🥜', '🫘', '🌰', '🍯', '🥛', '🍼',
      '🍵', '🧋', '🥤', '🍺', '🍻', '🍷', '🥂', '🍸', '🍹', '🧉', '🍾', '🍦', '🍧', '🍨',
      '🍮', '🥧', '🍫', '🍬', '🍭', '🍡', '🥮'
    ]
  } as const;
  const [selectedGroup, setSelectedGroup] = useState<keyof typeof emojiGroups>('rostos');
  const colorOptions = [
    '#5b5fc7',
    '#6264a7',
    '#4f6bed',
    '#0078d4',
    '#00b7c3',
    '#00a892',
    '#13a10e',
    '#8cbd18',
    '#ffb900',
    '#ff8c00',
    '#f7630c',
    '#e74856',
    '#d13438',
    '#c239b3',
    '#8e8cd8',
    '#6b7280'
  ];
  const isHexColor = /^#[0-9a-fA-F]{6}$/;
  const safeColor = isHexColor.test(avatarBg) ? avatarBg : profile.avatarBg;
  const resetDraftFromProps = () => {
    setDisplayName(profile.displayName);
    setStatusMessage(profile.statusMessage);
    setAvatarEmoji(profile.avatarEmoji);
    setCustomEmoji(profile.avatarEmoji);
    setAvatarBg(profile.avatarBg);
    setSelectedGroup('rostos');
    setRelayAutomatic(relaySettings?.automatic ?? true);
    setRelayHost(relaySettings?.host || '');
    setRelayPortDraft(String(relaySettings?.port || 43190));
    setOpenAtLogin(Boolean(startupSettings?.openAtLogin));
    setDownloadsDir(startupSettings?.downloadsDir || '');
    setDoNotDisturbUntil(Number(startupSettings?.doNotDisturbUntil || 0));
    setLanguageMode(languageSettings?.mode || 'auto');
    setBackupBusy(false);
    setRestoreBusy(false);
    setRediscoverBusy(false);
    setBackupFeedback('');
  };
  const dialogSurfaceStyle = {
    width: '85vw',
    maxWidth: '85vw',
    height: '85vh',
    maxHeight: '85vh'
  } as const;

  useEffect(() => {
    if (!open) return;
    resetDraftFromProps();
  }, [open, profile, relaySettings, startupSettings, languageSettings]);

  const parsedRelayPort = Number.parseInt(relayPortDraft, 10);
  const relayPort =
    Number.isFinite(parsedRelayPort) && parsedRelayPort > 0 && parsedRelayPort <= 65535
      ? parsedRelayPort
      : 43190;
  const relayHostTrimmed = relayHost.trim();
  const relayConfigValid = relayAutomatic || relayHostTrimmed.length > 0;
  const activeDoNotDisturbUntil =
    doNotDisturbUntil > Date.now() ? doNotDisturbUntil : 0;
  const doNotDisturbLabel = activeDoNotDisturbUntil
    ? `${locale === 'pt-BR' ? 'Ativo até' : locale === 'es' ? 'Activo hasta' : locale === 'fr' ? 'Actif jusqu’à' : 'Active until'} ${new Date(activeDoNotDisturbUntil).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : t('Disabled');
  const setDoNotDisturbFor = (milliseconds: number): void => {
    setDoNotDisturbUntil(Date.now() + milliseconds);
  };
  const setDoNotDisturbUntilTomorrow = (): void => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    setDoNotDisturbUntil(tomorrow.getTime());
  };

  const handleCreateBackup = async (): Promise<void> => {
    if (backupBusy || restoreBusy) return;
    setBackupBusy(true);
    setBackupFeedback('');
    try {
      const result = await ipcClient.createLocalBackup();
      if (result.canceled) {
        setBackupFeedback('Backup cancelado.');
        return;
      }
      setBackupFeedback(`Backup criado em: ${result.backupPath || 'pasta selecionada'}`);
    } catch (error) {
      setBackupFeedback(
        error instanceof Error ? error.message : 'Não foi possível criar o backup local.'
      );
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = async (): Promise<void> => {
    if (backupBusy || restoreBusy) return;
    setRestoreBusy(true);
    setBackupFeedback('');
    try {
      const result = await ipcClient.restoreLocalBackup();
      if (result.canceled) {
        setBackupFeedback('Restauração cancelada.');
        return;
      }
      setBackupFeedback('Restauração preparada. O aplicativo será reiniciado.');
    } catch (error) {
      setBackupFeedback(
        error instanceof Error ? error.message : 'Não foi possível restaurar o backup.'
      );
    } finally {
      setRestoreBusy(false);
    }
  };

  const handleForceRediscovery = async (): Promise<void> => {
    if (rediscoverBusy) return;
    setRediscoverBusy(true);
    try {
      await onForceRelayRediscovery();
    } finally {
      setRediscoverBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className="settings-modal" style={dialogSurfaceStyle}>
        <DialogBody>
          <DialogTitle>{t('Profile')}</DialogTitle>
          <DialogContent className="settings-layout">
            <section className="settings-preview-card">
              <Avatar emoji={avatarEmoji} bg={avatarBg} size={124} />
              <Text weight="semibold" size={500}>
                {displayName || profile.displayName}
              </Text>
              <Text size={300}>{statusMessage || t('Available')}</Text>
              <Text size={200}>ID: {profile.deviceId.slice(0, 12)}</Text>
            </section>

            <section className="settings-controls">
              <Field className="settings-field" label={t('Display name')}>
                <Input value={displayName} onChange={(_, data) => setDisplayName(data.value)} />
              </Field>
              <Field className="settings-field settings-field-status" label={t('Status message')}>
                <Input
                  value={statusMessage}
                  onChange={(_, data) => setStatusMessage(data.value)}
                  placeholder={locale === 'pt-BR' ? 'Ex.: Em reunião, respondo depois' : locale === 'es' ? 'Ej.: En reunión, respondo después' : locale === 'fr' ? 'Ex. : En réunion, je réponds plus tard' : 'E.g. In a meeting, I will reply later'}
                  maxLength={120}
                />
                <div className="status-presets">
                  {statusPresets.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      className={`status-chip ${statusMessage.trim() === preset.value ? 'active' : ''}`}
                      onClick={() => setStatusMessage(preset.value)}
                    >
                      {t(preset.key)}
                    </button>
                  ))}
                </div>
              </Field>

              <Field className="settings-field settings-field-emoji" label={t('Choose your emoji')}>
                <div className="emoji-group-tabs">
                  {(Object.keys(emojiGroups) as Array<keyof typeof emojiGroups>).map((group) => (
                    <button
                      type="button"
                      key={group}
                      className={`emoji-tab ${selectedGroup === group ? 'active' : ''}`}
                      onClick={() => setSelectedGroup(group)}
                    >
                      {group}
                    </button>
                  ))}
                </div>
                <div className="emoji-grid">
                  {emojiGroups[selectedGroup].map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`emoji-choice ${avatarEmoji === emoji ? 'active' : ''}`}
                      onClick={() => setAvatarEmoji(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                <div className="custom-emoji-row">
                  <Input
                    value={customEmoji}
                    onChange={(_, data) => setCustomEmoji(data.value)}
                    placeholder={t('Copy your custom emoji here')}
                  />
                  <Button
                    appearance="secondary"
                    onClick={() => {
                      const value = customEmoji.trim();
                      if (value) setAvatarEmoji(value);
                    }}
                  >
                    {t('Use emoji')}
                  </Button>
                </div>
              </Field>

              <Field className="settings-field settings-field-color" label={t('Profile color')}>
                <div className="color-wheel">
                  {colorOptions.map((color, index) => {
                    const angle = (360 / colorOptions.length) * index;
                    return (
                      <button
                        key={color}
                        type="button"
                        className={`color-node ${avatarBg.toLowerCase() === color.toLowerCase() ? 'active' : ''}`}
                        style={{
                          backgroundColor: color,
                          transform: `translate(-50%, -50%) rotate(${angle}deg) translate(66px) rotate(-${angle}deg)`
                        }}
                        onClick={() => setAvatarBg(color)}
                      />
                    );
                  })}
                  <div className="color-wheel-center">
                    <div className="color-preview" style={{ backgroundColor: avatarBg }} />
                  </div>
                </div>
                <div className="color-input-row">
                  <Input
                    value={avatarBg}
                    onChange={(_, data) => setAvatarBg(data.value)}
                    placeholder="#5b5fc7"
                  />
                  <input
                    type="color"
                    value={safeColor}
                    onChange={(event) => setAvatarBg(event.target.value)}
                  />
                </div>
              </Field>

              <Field className="settings-field settings-field-relay" label={t('Relay connection')}>
                <div className="settings-relay-toggle-row">
                  <Switch
                    label={t('Automatic')}
                    checked={relayAutomatic}
                    onChange={(_, data) => setRelayAutomatic(Boolean(data.checked))}
                  />
                  <Text size={200} className={`relay-connection-badge ${relaySettings?.connected ? 'online' : 'offline'}`}>
                    {relaySettings?.connected
                      ? `${t('Connected')}${relaySettings.endpoint ? `: ${relaySettings.endpoint}` : ''}`
                      : t('Disconnected')}
                  </Text>
                </div>
                {!relayAutomatic && (
                  <div className="settings-relay-manual-grid">
                    <Input
                      value={relayHost}
                      onChange={(_, data) => setRelayHost(data.value)}
                      placeholder={t('IP/Relay host (e.g. 192.168.0.50)')}
                    />
                    <Input
                      value={relayPortDraft}
                      onChange={(_, data) => setRelayPortDraft(data.value)}
                      placeholder={t('Port')}
                      type="number"
                      min={1}
                      max={65535}
                    />
                  </div>
                )}
                <div className="settings-relay-actions">
                  <Button
                    appearance="secondary"
                    disabled={rediscoverBusy}
                    onClick={() => void handleForceRediscovery()}
                  >
                    {rediscoverBusy ? t('Rediscovering...') : t('Rediscover now')}
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  {t('Automatic uses local network discovery. Manual forces a specific Relay.')}
                </Text>
              </Field>

              <Field className="settings-field" label={t('Startup')}>
                <div className="settings-relay-toggle-row">
                  <Switch
                    label={t('Start with the system')}
                    checked={openAtLogin}
                    disabled={!startupSettings?.supported}
                    onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))}
                  />
                  <Text size={200} className={`relay-connection-badge ${openAtLogin ? 'online' : 'offline'}`}>
                    {startupSettings?.supported
                      ? openAtLogin
                        ? t('Enabled')
                        : t('Disabled')
                      : 'Não suportado neste sistema'}
                  </Text>
                </div>
              </Field>

              <Field className="settings-field settings-field-dnd" label={t('Do not disturb')}>
                <div className="settings-relay-toggle-row">
                  <Text size={200} className={`relay-connection-badge ${activeDoNotDisturbUntil ? 'online' : 'offline'}`}>
                    {doNotDisturbLabel}
                  </Text>
                  {activeDoNotDisturbUntil > 0 && (
                    <Button appearance="secondary" onClick={() => setDoNotDisturbUntil(0)}>
                      {t('Turn off')}
                    </Button>
                  )}
                </div>
                <div className="settings-dnd-actions">
                  <Button appearance="secondary" onClick={() => setDoNotDisturbFor(15 * 60 * 1000)}>
                    15 min
                  </Button>
                  <Button appearance="secondary" onClick={() => setDoNotDisturbFor(60 * 60 * 1000)}>
                    1h
                  </Button>
                  <Button appearance="secondary" onClick={() => setDoNotDisturbUntilTomorrow()}>
                    {t('Until tomorrow')}
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  {t('Native notifications and sounds are silenced for the selected period.')}
                </Text>
              </Field>

              <Field className="settings-field" label={t('Default download folder')}>
                <div className="settings-relay-manual-grid">
                  <Input
                    value={downloadsDir}
                    onChange={(_, data) => setDownloadsDir(data.value)}
                    placeholder="Selecione a pasta para arquivos recebidos"
                  />
                  <Button
                    appearance="secondary"
                    onClick={() =>
                      void ipcClient.pickDirectory(downloadsDir).then((folder) => {
                        if (folder) setDownloadsDir(folder);
                      })
                    }
                  >
                    {t('Choose folder')}
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  {t('New received files will be saved in this folder.')}
                </Text>
              </Field>

              <Field className="settings-field settings-field-backup" label={t('Local backup and restore')}>
                <div className="settings-backup-actions">
                  <Button
                    appearance="secondary"
                    disabled={backupBusy || restoreBusy}
                    onClick={() => void handleCreateBackup()}
                  >
                    {backupBusy ? (locale === 'pt-BR' ? 'Gerando backup...' : 'Creating backup...') : t('Create backup')}
                  </Button>
                  <Button
                    appearance="secondary"
                    disabled={backupBusy || restoreBusy}
                    onClick={() => void handleRestoreBackup()}
                  >
                    {restoreBusy ? (locale === 'pt-BR' ? 'Preparando restauração...' : 'Preparing restore...') : t('Restore backup')}
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  {t('The backup includes local history (SQLite) and Lantern attachments.')}
                </Text>
                <Text size={200} className="settings-relay-help">
                  {t('After restoring, the app restarts automatically to apply the data.')}
                </Text>
                {backupFeedback && (
                  <Text size={200} className="settings-backup-feedback">
                    {backupFeedback}
                  </Text>
                )}
              </Field>
              <Field className="settings-field settings-field-language" label={t('Language')}>
                <select
                  className="settings-language-select"
                  value={languageMode}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === 'auto' || value === 'pt-BR' || value === 'en' || value === 'es' || value === 'fr') {
                      setLanguageMode(value);
                    }
                  }}
                >
                  <option value="auto">{t('Use system language')} ({languageSettings?.systemLocale || 'en'})</option>
                  <option value="pt-BR">{t('Portuguese (Brazil)')}</option>
                  <option value="en">{t('English')}</option>
                  <option value="es">{t('Spanish')}</option>
                  <option value="fr">{t('French')}</option>
                </select>
              </Field>
            </section>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('Cancel')}</Button>
            <Button
              className="settings-save-btn"
              appearance="primary"
              disabled={!relayConfigValid}
              onClick={() =>
                void onSave({
                  profile: {
                    displayName: displayName.trim() || profile.displayName,
                    avatarEmoji: avatarEmoji.trim() || profile.avatarEmoji,
                    avatarBg: isHexColor.test(avatarBg.trim()) ? avatarBg.trim() : profile.avatarBg,
                    statusMessage: statusMessage.trim() || 'Disponível'
                  },
                  relay: {
                    automatic: relayAutomatic,
                    host: relayAutomatic ? '' : relayHostTrimmed,
                    port: relayAutomatic ? 43190 : relayPort
                  },
                  startup: {
                    openAtLogin,
                    downloadsDir: downloadsDir.trim() || (startupSettings?.downloadsDir || ''),
                    doNotDisturbUntil: activeDoNotDisturbUntil
                  },
                  languageMode
                })
              }
            >
              {t('Save')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
