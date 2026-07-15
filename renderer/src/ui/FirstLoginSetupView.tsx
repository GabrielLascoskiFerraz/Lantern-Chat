import { useMemo, useState } from 'react';
import { Button, Spinner, Switch, Text } from '@fluentui/react-components';
import { ArrowLeft20Regular, ArrowRight20Regular } from '@fluentui/react-icons';
import { useLanternStore } from '../state/store';
import { Avatar } from './Avatar';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { FontSizeSelector, ThemeSelector } from './AppearancePreferences';
import appIcon from '../../../assets/icon.png';

const STEPS = [
  {
    title: 'Escolha seu emoji',
    description: 'Ele será sua identidade nas conversas, grupos e anúncios.'
  },
  {
    title: 'Agora escolha uma cor',
    description: 'A cor forma o fundo do seu avatar e ajuda seus contatos a reconhecer você.'
  },
  {
    title: 'Ajuste o Lantern neste dispositivo',
    description: 'Tema, tamanho da fonte e inicialização podem ser alterados depois em Configurações.'
  }
] as const;

export const FirstLoginSetupView = () => {
  const authState = useLanternStore((state) => state.authState);
  const startupSettings = useLanternStore((state) => state.startupSettings);
  const complete = useLanternStore((state) => state.completeFirstLoginSetup);
  const themeMode = useLanternStore((state) => state.themeMode);
  const setThemeMode = useLanternStore((state) => state.setThemeMode);
  const fontSizeMode = useLanternStore((state) => state.fontSizeMode);
  const setFontSizeMode = useLanternStore((state) => state.setFontSizeMode);
  const user = authState?.user;
  const [step, setStep] = useState(0);
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
          <div className="onboarding-brand"><img src={appIcon} alt="" /><span>Lantern</span></div>
          <div className="onboarding-progress" aria-label={`Etapa ${step + 1} de ${STEPS.length}`}>
            {STEPS.map((item, index) => <span key={item.title} className={index <= step ? 'active' : ''} />)}
          </div>
        </header>

        <div className="onboarding-copy">
          <Text className="onboarding-eyebrow">PRIMEIRO ACESSO · ETAPA {step + 1} DE {STEPS.length}</Text>
          <h1 id="onboarding-title">{step === 0 ? `${firstName}, ${STEPS[step].title.toLocaleLowerCase('pt-BR')}` : STEPS[step].title}</h1>
          <p>{STEPS[step].description}</p>
        </div>

        <div className="onboarding-layout">
          <aside className="onboarding-preview">
            <Avatar emoji={emoji} bg={color} size={112} />
            <strong>{user?.displayName}</strong>
            <span>@{user?.username}</span>
            <small>Disponível</small>
          </aside>

          <div className="onboarding-options">
            {step === 0 && (
              <ProfileIdentityEditor emoji={emoji} color={color} onEmojiChange={setEmoji} onColorChange={setColor} compact section="emoji" />
            )}

            {step === 1 && (
              <ProfileIdentityEditor emoji={emoji} color={color} onEmojiChange={setEmoji} onColorChange={setColor} compact section="color" />
            )}

            {step === 2 && (
              <div className="onboarding-device-preferences">
                <section className="onboarding-preference-section">
                  <header><h2>Tema</h2><p>Escolha a aparência do aplicativo.</p></header>
                  <ThemeSelector value={themeMode} onChange={setThemeMode} />
                </section>
                <section className="onboarding-preference-section">
                  <header><h2>Tamanho da fonte</h2><p>Ajuste a leitura e a quantidade de conteúdo na tela.</p></header>
                  <FontSizeSelector value={fontSizeMode} onChange={setFontSizeMode} />
                </section>
                <div className="onboarding-startup-option">
                  <div><strong>Abrir o Lantern ao iniciar o sistema</strong><span>Preferência válida somente para este computador.</span></div>
                  <Switch checked={openAtLogin} disabled={!startupSettings?.supported} onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))} aria-label="Abrir o Lantern ao iniciar o sistema" />
                </div>
              </div>
            )}

            {error && <div className="login-feedback" role="alert">{error}</div>}
            <div className="onboarding-actions">
              <Button appearance="secondary" icon={<ArrowLeft20Regular />} disabled={busy || step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>Voltar</Button>
              {step < STEPS.length - 1 ? (
                <Button appearance="primary" iconPosition="after" icon={<ArrowRight20Regular />} onClick={() => setStep((current) => Math.min(STEPS.length - 1, current + 1))}>Continuar</Button>
              ) : (
                <Button appearance="primary" disabled={busy} onClick={() => void submit()}>{busy ? <><Spinner size="tiny" /> Salvando...</> : 'Entrar no Lantern'}</Button>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
};
