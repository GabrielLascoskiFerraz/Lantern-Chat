import { useEffect, useMemo, useState } from 'react';
import {
  Alert20Regular,
  AnimalCat20Regular,
  Apps20Regular,
  Briefcase20Regular,
  Checkmark20Regular,
  Desktop20Regular,
  Emoji20Regular,
  Food20Regular,
  LockClosed20Regular,
  Person20Regular,
  Search20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular
} from '@fluentui/react-icons';
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
  themeMode: 'system' | 'light' | 'dark';
  onThemeModeChange: (mode: 'system' | 'light' | 'dark') => void;
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

type SettingsSection = 'profile' | 'relay' | 'notifications' | 'application';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSection;
  icon: typeof Person20Regular;
  labelKey: string;
  descriptionKey: string;
}> = [
  { id: 'profile', icon: Person20Regular, labelKey: 'Profile', descriptionKey: 'Name, status and visual identity' },
  { id: 'relay', icon: LockClosed20Regular, labelKey: 'Relay', descriptionKey: 'Connection and discovery preferences' },
  { id: 'notifications', icon: Alert20Regular, labelKey: 'Notifications', descriptionKey: 'Quiet hours and alerts' },
  { id: 'application', icon: Apps20Regular, labelKey: 'Application', descriptionKey: 'Startup, files, language and backup' }
];

const PROFILE_EMOJI_GROUP_LABELS = {
  rostos: 'Faces',
  trabalho: 'Work',
  animais: 'Animals',
  comida: 'Food'
} as const;

const PROFILE_EMOJI_GROUP_ICONS = {
  rostos: Emoji20Regular,
  trabalho: Briefcase20Regular,
  animais: AnimalCat20Regular,
  comida: Food20Regular
} as const;

export const SettingsModal = ({
  open,
  profile,
  relaySettings,
  startupSettings,
  languageSettings,
  themeMode,
  onThemeModeChange,
  onForceRelayRediscovery,
  onClose,
  onSave
}: SettingsModalProps) => {
  const { t, locale } = useI18n();
  const [activeSection, setActiveSection] = useState<SettingsSection>('profile');
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [statusMessage, setStatusMessage] = useState(profile.statusMessage);
  const [avatarEmoji, setAvatarEmoji] = useState(profile.avatarEmoji);
  const [customEmoji, setCustomEmoji] = useState(profile.avatarEmoji);
  const [profileEmojiQuery, setProfileEmojiQuery] = useState('');
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
  const visibleProfileEmojis = useMemo(() => {
    const normalizedQuery = profileEmojiQuery
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();
    if (!normalizedQuery) return emojiGroups[selectedGroup];

    return Object.entries(emojiGroups).flatMap(([group, emojis]) =>
      emojis.filter((emoji) => `${emoji} ${group}`.toLowerCase().includes(normalizedQuery))
    );
  }, [emojiGroups, profileEmojiQuery, selectedGroup]);
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
    setActiveSection('profile');
    setDisplayName(profile.displayName);
    setStatusMessage(profile.statusMessage);
    setAvatarEmoji(profile.avatarEmoji);
    setCustomEmoji(profile.avatarEmoji);
    setProfileEmojiQuery('');
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
        setBackupFeedback(t('Backup canceled.'));
        return;
      }
      setBackupFeedback(
        `${t('Backup created at:')} ${result.backupPath || t('selected folder')}`
      );
    } catch (error) {
      setBackupFeedback(
        error instanceof Error ? error.message : t('Could not create the local backup.')
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
        setBackupFeedback(t('Restore canceled.'));
        return;
      }
      setBackupFeedback(t('Restore prepared. The app will restart.'));
    } catch (error) {
      setBackupFeedback(
        error instanceof Error ? error.message : t('Could not restore the local backup.')
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
          <DialogTitle>
            <div className="settings-title-row">
              <div>
                <span>{t('Settings')}</span>
                <Text size={200}>{t('Personalize Lantern on this device.')}</Text>
              </div>
            </div>
          </DialogTitle>
          <DialogContent className="settings-content">
            <nav className="settings-navigation" aria-label={t('Settings sections')}>
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
                    <span className="settings-navigation-icon" aria-hidden="true"><SectionIcon /></span>
                    <span><strong>{t(section.labelKey)}</strong><small>{t(section.descriptionKey)}</small></span>
                  </button>
                );
              })}
            </nav>

            <div className="settings-section-panel">
              {activeSection === 'profile' && (
                <section aria-labelledby="settings-profile-title">
                  <header className="settings-section-heading">
                    <div><h2 id="settings-profile-title">{t('Profile')}</h2><p>{t('Name, status and visual identity')}</p></div>
                  </header>
                  <div className="settings-profile-layout">
                    <aside className="settings-preview-card" aria-label={t('Profile preview')}>
                      <span className="settings-preview-eyebrow">{t('Preview')}</span>
                      <Avatar emoji={avatarEmoji} bg={avatarBg} size={116} />
                      <Text weight="semibold" size={500}>{displayName.trim() || profile.displayName}</Text>
                      <Text size={300}>{statusMessage.trim() || t('Available')}</Text>
                      <Text size={200} className="settings-profile-id">ID {profile.deviceId.slice(0, 12)}</Text>
                    </aside>
                    <div className="settings-profile-form">
                      <div className="settings-card settings-basic-profile-card">
                        <Field label={t('Display name')}><Input value={displayName} maxLength={80} onChange={(_, data) => setDisplayName(data.value)} /></Field>
                        <Field label={t('Status message')}>
                          <Input value={statusMessage} onChange={(_, data) => setStatusMessage(data.value)} placeholder={t('E.g. In a meeting, I will reply later')} maxLength={120} />
                          <div className="status-presets" aria-label={t('Status suggestions')}>
                            {statusPresets.map((preset) => <button type="button" key={preset.key} aria-pressed={statusMessage.trim() === preset.value} className={`status-chip ${statusMessage.trim() === preset.value ? 'active' : ''}`} onClick={() => setStatusMessage(preset.value)}>{t(preset.key)}</button>)}
                          </div>
                        </Field>
                      </div>
                      <section className="profile-identity-editor" aria-label={t('Visual identity')}>
                        <div className="identity-editor-section identity-emoji-section">
                          <header className="identity-section-header">
                            <div><h3>{t('Emoji')}</h3><Text size={200}>{t('Choose how you appear in conversations.')}</Text></div>
                          </header>
                          <Input className="identity-emoji-search" contentBefore={<Search20Regular aria-hidden="true" />} value={profileEmojiQuery} onChange={(_, data) => setProfileEmojiQuery(data.value)} placeholder={t('Search by cat, work, party...')} aria-label={t('Search profile emoji')} />
                          {!profileEmojiQuery.trim() && <div className="identity-category-tabs" role="tablist" aria-label={t('Emoji categories')}>
                            {(Object.keys(emojiGroups) as Array<keyof typeof emojiGroups>).map((group) => {
                              const CategoryIcon = PROFILE_EMOJI_GROUP_ICONS[group];
                              return <button type="button" key={group} role="tab" aria-selected={selectedGroup === group} className={selectedGroup === group ? 'active' : ''} onClick={() => setSelectedGroup(group)}><CategoryIcon aria-hidden="true" /><span>{t(PROFILE_EMOJI_GROUP_LABELS[group])}</span></button>;
                            })}
                          </div>}
                          <div className="identity-emoji-grid" role="listbox" aria-label={profileEmojiQuery.trim() ? t('Emoji search results') : t('Choose your emoji')}>
                            {visibleProfileEmojis.map((emoji) => {
                              const selected = avatarEmoji === emoji;
                              return <button key={emoji} type="button" role="option" aria-selected={selected} aria-label={`${t('Use emoji')} ${emoji}`} className={selected ? 'selected' : ''} onClick={() => setAvatarEmoji(emoji)}><span aria-hidden="true">{emoji}</span>{selected && <Checkmark20Regular aria-hidden="true" />}</button>;
                            })}
                          </div>
                          {visibleProfileEmojis.length === 0 && <div className="identity-empty">{t('No profile emoji found.')}</div>}
                          <div className="identity-custom-row"><Input value={customEmoji} onChange={(_, data) => setCustomEmoji(data.value)} placeholder={t('Paste an emoji')} aria-label={t('Custom emoji')} /><Button appearance="secondary" onClick={() => { const value = customEmoji.trim(); if (value) setAvatarEmoji(value); }}>{t('Use emoji')}</Button></div>
                        </div>
                        <div className="identity-editor-section identity-color-section">
                          <header className="identity-section-header"><div><h3>{t('Profile color')}</h3><Text size={200}>{t('Choose the color of your avatar.')}</Text></div></header>
                          <div className="identity-color-grid">
                            {colorOptions.map((color) => <button key={color} type="button" className={avatarBg.toLowerCase() === color.toLowerCase() ? 'selected' : ''} style={{ backgroundColor: color }} aria-label={`${t('Use color')} ${color}`} onClick={() => setAvatarBg(color)}>{avatarBg.toLowerCase() === color.toLowerCase() && <Checkmark20Regular aria-hidden="true" />}</button>)}
                          </div>
                          <div className="identity-custom-color-row"><input type="color" value={safeColor} onChange={(event) => setAvatarBg(event.target.value)} aria-label={t('Custom color')} /><Input value={avatarBg} onChange={(_, data) => setAvatarBg(data.value)} placeholder="#5b5fc7" aria-label={t('Custom color')} /></div>
                        </div>
                      </section>
                    </div>
                  </div>
                </section>
              )}

              {activeSection === 'relay' && (
                <section aria-labelledby="settings-relay-title">
                  <header className="settings-section-heading"><div><h2 id="settings-relay-title">{t('Relay')}</h2><p>{t('Connection and discovery preferences')}</p></div></header>
                  <div className="settings-card settings-option-card">
                    <div className="settings-switch-row"><div><h3>{t('Relay connection')}</h3><p>{t('Automatic uses local network discovery. Manual forces a specific Relay.')}</p></div><Switch label={t('Automatic')} checked={relayAutomatic} onChange={(_, data) => setRelayAutomatic(Boolean(data.checked))} /></div>
                    <div className="settings-relay-status-row"><Text size={200} className={`relay-connection-badge ${relaySettings?.connected ? 'online' : 'offline'}`}>{relaySettings?.connected ? `${t('Connected')}${relaySettings.endpoint ? `: ${relaySettings.endpoint}` : ''}` : t('Disconnected')}</Text><Button appearance="secondary" disabled={rediscoverBusy} onClick={() => void handleForceRediscovery()}>{rediscoverBusy ? t('Rediscovering...') : t('Rediscover now')}</Button></div>
                    {!relayAutomatic && <div className="settings-relay-manual-grid"><Input value={relayHost} onChange={(_, data) => setRelayHost(data.value)} placeholder={t('IP/Relay host (e.g. 192.168.0.50)')} /><Input value={relayPortDraft} onChange={(_, data) => setRelayPortDraft(data.value)} placeholder={t('Port')} type="number" min={1} max={65535} /></div>}
                  </div>
                </section>
              )}

              {activeSection === 'notifications' && (
                <section aria-labelledby="settings-notifications-title">
                  <header className="settings-section-heading"><div><h2 id="settings-notifications-title">{t('Notifications')}</h2><p>{t('Quiet hours and alerts')}</p></div></header>
                  <div className="settings-card settings-option-card">
                    <div className="settings-option-heading"><div><h3>{t('Do not disturb')}</h3><p>{t('Native notifications and sounds are silenced for the selected period.')}</p></div><span className={`settings-state-pill ${activeDoNotDisturbUntil ? 'enabled' : ''}`}>{doNotDisturbLabel}</span></div>
                    <div className="settings-dnd-actions"><Button appearance="secondary" onClick={() => setDoNotDisturbFor(15 * 60 * 1000)}>15 min</Button><Button appearance="secondary" onClick={() => setDoNotDisturbFor(60 * 60 * 1000)}>1h</Button><Button appearance="secondary" onClick={() => setDoNotDisturbUntilTomorrow()}>{t('Until tomorrow')}</Button>{activeDoNotDisturbUntil > 0 && <Button appearance="subtle" onClick={() => setDoNotDisturbUntil(0)}>{t('Turn off')}</Button>}</div>
                  </div>
                </section>
              )}

              {activeSection === 'application' && (
                <section aria-labelledby="settings-application-title">
                  <header className="settings-section-heading"><div><h2 id="settings-application-title">{t('Application')}</h2><p>{t('These settings only apply to this device.')}</p></div></header>
                  <div className="settings-card settings-option-card"><div className="settings-switch-row"><div><h3>{t('Start with the system')}</h3><p>{t('Start Lantern automatically after you sign in to your computer.')}</p></div><Switch checked={openAtLogin} disabled={!startupSettings?.supported} onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))} aria-label={t('Start with the system')} /></div>{!startupSettings?.supported && <Text size={200} className="settings-inline-help">{t('Not supported on this system')}</Text>}</div>
                  <div className="settings-card settings-option-card">
                    <div className="settings-option-heading"><div><h3>{t('Theme')}</h3><p>{t('Choose how Lantern looks on this device.')}</p></div><span className="settings-state-pill">{themeMode === 'system' ? t('System') : themeMode === 'light' ? t('Light') : t('Dark')}</span></div>
                    <div className="settings-theme-options" role="radiogroup" aria-label={t('Theme')}>
                      <button type="button" className={themeMode === 'system' ? 'active' : ''} role="radio" aria-checked={themeMode === 'system'} onClick={() => onThemeModeChange('system')}>
                        <span className="settings-theme-preview system" aria-hidden="true"><span /><span /></span>
                        <span className="settings-theme-option-label"><Desktop20Regular aria-hidden="true" /><span><strong>{t('System')}</strong><small>{t('Follow device')}</small></span></span>
                      </button>
                      <button type="button" className={themeMode === 'light' ? 'active' : ''} role="radio" aria-checked={themeMode === 'light'} onClick={() => onThemeModeChange('light')}>
                        <span className="settings-theme-preview light" aria-hidden="true"><span /></span>
                        <span className="settings-theme-option-label"><WeatherSunny20Regular aria-hidden="true" /><span><strong>{t('Light')}</strong><small>{t('Bright surfaces')}</small></span></span>
                      </button>
                      <button type="button" className={themeMode === 'dark' ? 'active' : ''} role="radio" aria-checked={themeMode === 'dark'} onClick={() => onThemeModeChange('dark')}>
                        <span className="settings-theme-preview dark" aria-hidden="true"><span /></span>
                        <span className="settings-theme-option-label"><WeatherMoon20Regular aria-hidden="true" /><span><strong>{t('Dark')}</strong><small>{t('Less screen glare')}</small></span></span>
                      </button>
                    </div>
                  </div>
                  <div className="settings-card settings-option-card"><div className="settings-option-heading"><div><h3>{t('Default download folder')}</h3><p>{t('New received files will be saved in this folder.')}</p></div></div><div className="settings-directory-row"><Input value={downloadsDir} onChange={(_, data) => setDownloadsDir(data.value)} placeholder={t('Select a folder for received files')} /><Button appearance="secondary" onClick={() => void ipcClient.pickDirectory(downloadsDir).then((folder) => { if (folder) setDownloadsDir(folder); })}>{t('Choose folder')}</Button></div></div>
                  <div className="settings-card settings-option-card"><div className="settings-option-heading"><div><h3>{t('Language')}</h3><p>{t('Choose the language used by Lantern on this device.')}</p></div></div><select className="settings-language-select" value={languageMode} onChange={(event) => { const value = event.target.value; if (value === 'auto' || value === 'pt-BR' || value === 'en' || value === 'es' || value === 'fr') setLanguageMode(value); }}><option value="auto">{t('Use system language')} ({languageSettings?.systemLocale || 'en'})</option><option value="pt-BR">{t('Portuguese (Brazil)')}</option><option value="en">{t('English')}</option><option value="es">{t('Spanish')}</option><option value="fr">{t('French')}</option></select></div>
                  <div className="settings-card settings-option-card"><div className="settings-option-heading"><div><h3>{t('Local backup and restore')}</h3><p>{t('The backup includes local history (SQLite) and Lantern attachments.')}</p></div></div><div className="settings-backup-actions"><Button appearance="secondary" disabled={backupBusy || restoreBusy} onClick={() => void handleCreateBackup()}>{backupBusy ? t('Creating backup...') : t('Create backup')}</Button><Button appearance="secondary" disabled={backupBusy || restoreBusy} onClick={() => void handleRestoreBackup()}>{restoreBusy ? t('Preparing restore...') : t('Restore backup')}</Button></div><Text size={200} className="settings-inline-help">{t('After restoring, the app restarts automatically to apply the data.')}</Text>{backupFeedback && <Text size={200} className="settings-backup-feedback">{backupFeedback}</Text>}</div>
                </section>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>{t('Cancel')}</Button>
            <Button className="settings-save-btn" appearance="primary" disabled={!relayConfigValid} onClick={() => void onSave({ profile: { displayName: displayName.trim() || profile.displayName, avatarEmoji: avatarEmoji.trim() || profile.avatarEmoji, avatarBg: isHexColor.test(avatarBg.trim()) ? avatarBg.trim() : profile.avatarBg, statusMessage: statusMessage.trim() || t('Available') }, relay: { automatic: relayAutomatic, host: relayAutomatic ? '' : relayHostTrimmed, port: relayAutomatic ? 43190 : relayPort }, startup: { openAtLogin, downloadsDir: downloadsDir.trim() || (startupSettings?.downloadsDir || ''), doNotDisturbUntil: activeDoNotDisturbUntil }, languageMode })}>{t('Save')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
