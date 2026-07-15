import { useMemo, useState } from 'react';
import { Button, Spinner, Switch, Text } from '@fluentui/react-components';
import { Checkmark20Regular } from '@fluentui/react-icons';
import { useLanternStore } from '../state/store';
import { Avatar } from './Avatar';
import appIcon from '../../../assets/icon.png';

const EMOJIS = ['🙂', '😀', '😎', '🤓', '🧠', '🧑‍💻', '🚀', '✨', '🌟', '🦊', '🐱', '🐼', '🦉', '☕', '🎯', '💡'];
const COLORS = ['#147ad6', '#4f6bed', '#5b5fc7', '#8764b8', '#c239b3', '#d13438', '#f7630c', '#ffb900', '#107c10', '#00a892', '#00b7c3', '#69797e'];

export const FirstLoginSetupView = () => {
  const authState = useLanternStore((state) => state.authState);
  const startupSettings = useLanternStore((state) => state.startupSettings);
  const complete = useLanternStore((state) => state.completeFirstLoginSetup);
  const user = authState?.user;
  const [emoji, setEmoji] = useState(user?.avatarEmoji || '🙂');
  const [color, setColor] = useState(user?.avatarBg || '#147ad6');
  const [openAtLogin, setOpenAtLogin] = useState(Boolean(startupSettings?.openAtLogin));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstName = useMemo(() => user?.displayName.trim().split(/\s+/)[0] || 'Olá', [user?.displayName]);

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await complete({ avatarEmoji: emoji, avatarBg: color, openAtLogin });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a configuração.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="onboarding-screen">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <div className="onboarding-brand">
            <img src={appIcon} alt="" />
            <span>Lantern</span>
          </div>
          <div className="onboarding-progress"><span className="active" /><span className="active" /><span className="active" /></div>
        </header>

        <div className="onboarding-copy">
          <Text className="onboarding-eyebrow">PRIMEIRO ACESSO</Text>
          <h1 id="onboarding-title">{firstName}, deixe o Lantern com a sua cara</h1>
          <p>Estas informações acompanham sua conta neste Relay. A inicialização automática vale somente para este computador.</p>
        </div>

        <div className="onboarding-layout">
          <aside className="onboarding-preview">
            <Avatar emoji={emoji} bg={color} size={112} />
            <strong>{user?.displayName}</strong>
            <span>@{user?.username}</span>
            <small>Disponível</small>
          </aside>

          <div className="onboarding-options">
            <fieldset>
              <legend>Escolha seu emoji</legend>
              <div className="onboarding-emoji-grid">
                {EMOJIS.map((item) => (
                  <button key={item} type="button" className={emoji === item ? 'selected' : ''} onClick={() => setEmoji(item)} aria-label={`Usar ${item}`}>
                    {item}{emoji === item && <Checkmark20Regular />}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend>Escolha uma cor</legend>
              <div className="onboarding-color-grid">
                {COLORS.map((item) => (
                  <button key={item} type="button" className={color === item ? 'selected' : ''} style={{ backgroundColor: item }} onClick={() => setColor(item)} aria-label={`Usar cor ${item}`}>
                    {color === item && <Checkmark20Regular />}
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="onboarding-startup-option">
              <div><strong>Abrir o Lantern ao iniciar o sistema</strong><span>Você pode alterar isso depois em Perfil.</span></div>
              <Switch checked={openAtLogin} disabled={!startupSettings?.supported} onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))} />
            </div>

            {error && <div className="login-feedback" role="alert">{error}</div>}
            <Button appearance="primary" size="large" disabled={busy} onClick={() => void submit()}>
              {busy ? <><Spinner size="tiny" /> Salvando...</> : 'Entrar no Lantern'}
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
};
