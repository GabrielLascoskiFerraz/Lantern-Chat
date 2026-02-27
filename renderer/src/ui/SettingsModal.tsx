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
import { ipcClient, Profile, RelaySettings, StartupSettings } from '../api/ipcClient';
import { Avatar } from './Avatar';

interface SettingsModalProps {
  open: boolean;
  profile: Profile;
  relaySettings: RelaySettings | null;
  startupSettings: StartupSettings | null;
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
    };
  }) => Promise<void>;
}

export const SettingsModal = ({
  open,
  profile,
  relaySettings,
  startupSettings,
  onClose,
  onSave
}: SettingsModalProps) => {
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
  }, [open, profile, relaySettings, startupSettings]);

  const parsedRelayPort = Number.parseInt(relayPortDraft, 10);
  const relayPort =
    Number.isFinite(parsedRelayPort) && parsedRelayPort > 0 && parsedRelayPort <= 65535
      ? parsedRelayPort
      : 43190;
  const relayHostTrimmed = relayHost.trim();
  const relayConfigValid = relayAutomatic || relayHostTrimmed.length > 0;

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

              <Field className="settings-field settings-field-relay" label="Conexão com Relay">
                <div className="settings-relay-toggle-row">
                  <Switch
                    label="Automático"
                    checked={relayAutomatic}
                    onChange={(_, data) => setRelayAutomatic(Boolean(data.checked))}
                  />
                  <Text size={200} className={`relay-connection-badge ${relaySettings?.connected ? 'online' : 'offline'}`}>
                    {relaySettings?.connected
                      ? `Conectado${relaySettings.endpoint ? `: ${relaySettings.endpoint}` : ''}`
                      : 'Desconectado'}
                  </Text>
                </div>
                {!relayAutomatic && (
                  <div className="settings-relay-manual-grid">
                    <Input
                      value={relayHost}
                      onChange={(_, data) => setRelayHost(data.value)}
                      placeholder="IP/host do Relay (ex.: 192.168.0.50)"
                    />
                    <Input
                      value={relayPortDraft}
                      onChange={(_, data) => setRelayPortDraft(data.value)}
                      placeholder="Porta"
                      type="number"
                      min={1}
                      max={65535}
                    />
                  </div>
                )}
                <Text size={200} className="settings-relay-help">
                  Automático usa descoberta na rede local. Manual força um Relay específico.
                </Text>
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
                    downloadsDir: downloadsDir.trim() || (startupSettings?.downloadsDir || '')
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
