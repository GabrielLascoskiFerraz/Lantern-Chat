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
import { ipcClient, Profile, StartupSettings } from '../api/ipcClient';
import { Avatar } from './Avatar';

interface SettingsModalProps {
  open: boolean;
  profile: Profile;
  startupSettings: StartupSettings | null;
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

export const SettingsModal = ({
  open,
  profile,
  startupSettings,
  onClose,
  onSave
}: SettingsModalProps) => {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [statusMessage, setStatusMessage] = useState(profile.statusMessage);
  const [avatarEmoji, setAvatarEmoji] = useState(profile.avatarEmoji);
  const [customEmoji, setCustomEmoji] = useState(profile.avatarEmoji);
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
  const statusPresets = ['Disponível', 'Em reunião', 'Foco total', 'Volto já', 'Não perturbe'];
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
  const emojiGroupLabels: Record<keyof typeof emojiGroups, string> = {
    rostos: 'Rostos e emoções',
    trabalho: 'Trabalho',
    animais: 'Animais',
    comida: 'Comidas e bebidas'
  };
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
    setOpenAtLogin(Boolean(startupSettings?.openAtLogin));
    setDownloadsDir(startupSettings?.downloadsDir || '');
    setDoNotDisturbUntil(Number(startupSettings?.doNotDisturbUntil || 0));
    setPasswordExpanded(false);
    setCurrentPassword('');
    setNewPassword('');
    setNewPasswordConfirm('');
    setPasswordFeedback('');
    setPasswordChanged(false);
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
  }, [open, profile, startupSettings]);

  const activeDoNotDisturbUntil =
    doNotDisturbUntil > Date.now() ? doNotDisturbUntil : 0;
  const doNotDisturbLabel = activeDoNotDisturbUntil
    ? `Ativo até ${new Date(activeDoNotDisturbUntil).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit'
      })}`
    : 'Desativado';
  const setDoNotDisturbFor = (milliseconds: number): void => {
    setDoNotDisturbUntil(Date.now() + milliseconds);
  };
  const setDoNotDisturbUntilTomorrow = (): void => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    setDoNotDisturbUntil(tomorrow.getTime());
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className="settings-modal" style={dialogSurfaceStyle}>
        <DialogBody>
          <DialogTitle>Perfil</DialogTitle>
          <DialogContent className="settings-layout">
            <section className="settings-preview-card">
              <Avatar emoji={avatarEmoji} bg={avatarBg} size={124} />
              <Text weight="semibold" size={500}>
                {displayName || profile.displayName}
              </Text>
              <Text size={300}>{statusMessage || 'Disponível'}</Text>
              <Text size={200}>ID: {profile.deviceId.slice(0, 12)}</Text>
            </section>

            <section className="settings-controls">
              <Field className="settings-field" label="Nome de exibição">
                <Input value={displayName} onChange={(_, data) => setDisplayName(data.value)} />
              </Field>
              <Field className="settings-field settings-field-status" label="Mensagem de status">
                <Input
                  value={statusMessage}
                  onChange={(_, data) => setStatusMessage(data.value)}
                  placeholder="Ex.: Em reunião, respondo depois"
                  maxLength={120}
                />
                <div className="status-presets">
                  {statusPresets.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      className={`status-chip ${statusMessage.trim() === preset ? 'active' : ''}`}
                      onClick={() => setStatusMessage(preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
              </Field>

              <Field className="settings-field settings-field-emoji" label="Escolha seu emoji">
                <div className="emoji-group-tabs">
                  {(Object.keys(emojiGroups) as Array<keyof typeof emojiGroups>).map((group) => (
                    <button
                      type="button"
                      key={group}
                      className={`emoji-tab ${selectedGroup === group ? 'active' : ''}`}
                      onClick={() => setSelectedGroup(group)}
                    >
                      {emojiGroupLabels[group]}
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
                    placeholder="Cole seu emoji personalizado aqui"
                  />
                  <Button
                    appearance="secondary"
                    onClick={() => {
                      const value = customEmoji.trim();
                      if (value) setAvatarEmoji(value);
                    }}
                  >
                    Usar Emoji
                  </Button>
                </div>
              </Field>

              <Field className="settings-field settings-field-color" label="Cor do perfil">
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

              <Field className="settings-field" label="Inicialização">
                <div className="settings-relay-toggle-row">
                  <Switch
                    label="Iniciar com o sistema"
                    checked={openAtLogin}
                    disabled={!startupSettings?.supported}
                    onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))}
                  />
                  <Text size={200} className={`relay-connection-badge ${openAtLogin ? 'online' : 'offline'}`}>
                    {startupSettings?.supported
                      ? openAtLogin
                        ? 'Ativado'
                        : 'Desativado'
                      : 'Não suportado neste sistema'}
                  </Text>
                </div>
              </Field>

              <Field className="settings-field" label="Segurança da conta">
                {!passwordExpanded ? (
                  <Button appearance="secondary" onClick={() => setPasswordExpanded(true)}>
                    Alterar senha
                  </Button>
                ) : (
                  <div className="settings-password-panel">
                    <Input
                      type="password"
                      value={currentPassword}
                      onChange={(_, data) => setCurrentPassword(data.value)}
                      placeholder="Senha atual"
                      autoComplete="current-password"
                    />
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(_, data) => setNewPassword(data.value)}
                      placeholder="Nova senha (mín. 10 caracteres)"
                      autoComplete="new-password"
                    />
                    <Input
                      type="password"
                      value={newPasswordConfirm}
                      onChange={(_, data) => setNewPasswordConfirm(data.value)}
                      placeholder="Confirmar nova senha"
                      autoComplete="new-password"
                    />
                    {passwordFeedback && <Text size={200} className={`settings-password-feedback ${passwordChanged ? 'success' : ''}`}>{passwordFeedback}</Text>}
                    <div className="settings-password-actions">
                      <Button appearance="subtle" onClick={() => {
                        setPasswordExpanded(false);
                        setPasswordFeedback('');
                        setPasswordChanged(false);
                      }}>Cancelar</Button>
                      <Button
                        appearance="primary"
                        disabled={passwordBusy || !currentPassword || newPassword.length < 10 || newPassword !== newPasswordConfirm}
                        onClick={() => {
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
                              setPasswordChanged(false);
                              setPasswordFeedback(message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, ''));
                            })
                            .finally(() => setPasswordBusy(false));
                        }}
                      >Salvar nova senha</Button>
                    </div>
                  </div>
                )}
              </Field>

              <Field className="settings-field settings-field-dnd" label="Não perturbe">
                <div className="settings-relay-toggle-row">
                  <Text size={200} className={`relay-connection-badge ${activeDoNotDisturbUntil ? 'online' : 'offline'}`}>
                    {doNotDisturbLabel}
                  </Text>
                  {activeDoNotDisturbUntil > 0 && (
                    <Button appearance="secondary" onClick={() => setDoNotDisturbUntil(0)}>
                      Desativar
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
                    Até amanhã
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  Silencia notificações nativas e sons pelo período escolhido.
                </Text>
              </Field>

              <Field className="settings-field" label="Pasta padrão de recebimento">
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
                    Escolher pasta
                  </Button>
                </div>
                <Text size={200} className="settings-relay-help">
                  Os novos arquivos recebidos serão salvos nesta pasta.
                </Text>
              </Field>

            </section>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>Cancelar</Button>
            <Button
              className="settings-save-btn"
              appearance="primary"
              onClick={() =>
                void onSave({
                  profile: {
                    displayName: displayName.trim() || profile.displayName,
                    avatarEmoji: avatarEmoji.trim() || profile.avatarEmoji,
                    avatarBg: isHexColor.test(avatarBg.trim()) ? avatarBg.trim() : profile.avatarBg,
                    statusMessage: statusMessage.trim() || 'Disponível'
                  },
                  startup: {
                    openAtLogin,
                    downloadsDir: downloadsDir.trim() || (startupSettings?.downloadsDir || ''),
                    doNotDisturbUntil: activeDoNotDisturbUntil
                  }
                })
              }
            >
              Salvar
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
