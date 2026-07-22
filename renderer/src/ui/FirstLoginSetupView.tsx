import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Spinner, Switch, Text } from '@fluentui/react-components';
import { ArrowLeft20Regular, ArrowRight20Regular } from '@fluentui/react-icons';
import { useLanternStore } from '../state/store';
import { Avatar } from './Avatar';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { DensitySelector, FontSizeSelector, ThemeSelector } from './AppearancePreferences';
import { PasswordInput } from './PasswordInput';
import appIcon from '../../../assets/icon.png';

const PROFILE_STEPS = [
  {
    id: 'emoji',
    title: 'Escolha seu emoji',
    description: 'Ele será sua identidade nas conversas, grupos e anúncios.'
  },
  {
    id: 'color',
    title: 'Agora escolha uma cor',
    description: 'A cor forma o fundo do seu avatar e ajuda seus contatos a reconhecer você.'
  },
  {
    id: 'theme',
    title: 'Escolha o tema',
    description: 'Use o tema do sistema ou escolha uma aparência clara ou escura.'
  },
  {
    id: 'font',
    title: 'Ajuste o tamanho da fonte',
    description: 'Escolha o tamanho que oferece a leitura mais confortável para você.'
  },
  {
    id: 'density',
    title: 'Escolha a densidade',
    description: 'Defina quanto espaço o Lantern deve usar entre listas, controles e conteúdos.'
  },
  {
    id: 'startup',
    title: 'Defina a inicialização',
    description: 'Escolha se o Lantern deve abrir automaticamente com este computador.'
  }
] as const;

export const FirstLoginSetupView = () => {
  const authState = useLanternStore((state) => state.authState);
  const startupSettings = useLanternStore((state) => state.startupSettings);
  const completeInitialPassword = useLanternStore((state) => state.completeInitialPassword);
  const complete = useLanternStore((state) => state.completeFirstLoginSetup);
  const themeMode = useLanternStore((state) => state.themeMode);
  const setThemeMode = useLanternStore((state) => state.setThemeMode);
  const fontSizeMode = useLanternStore((state) => state.fontSizeMode);
  const setFontSizeMode = useLanternStore((state) => state.setFontSizeMode);
  const densityMode = useLanternStore((state) => state.densityMode);
  const setDensityMode = useLanternStore((state) => state.setDensityMode);
  const user = authState?.user;
  const [step, setStep] = useState(0);
  const [emoji, setEmoji] = useState(user?.avatarEmoji || '🙂');
  const [color, setColor] = useState(user?.avatarBg || '#147ad6');
  const [openAtLogin, setOpenAtLogin] = useState(true);
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstName = useMemo(() => user?.displayName.trim().split(/\s+/)[0] || 'Olá', [user?.displayName]);
  const steps = useMemo(() => [
    ...(user?.passwordSetupRequired ? [{
      id: 'password' as const,
      title: 'Crie sua senha',
      description: 'Esta conta foi preparada pelo administrador. Defina uma senha pessoal para protegê-la.'
    }] : []),
    ...(!user?.profileSetupCompleted ? PROFILE_STEPS : [])
  ], [user?.passwordSetupRequired, user?.profileSetupCompleted]);
  const currentStep = steps[Math.min(step, Math.max(0, steps.length - 1))];

  useEffect(() => {
    if (!user || user.profileSetupCompleted) return;
    setThemeMode('system');
    setFontSizeMode('medium');
    setDensityMode('standard');
    setOpenAtLogin(true);
  }, [setDensityMode, setFontSizeMode, setThemeMode, user?.profileSetupCompleted, user?.username]);

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

  const advance = async () => {
    if (currentStep?.id !== 'password') {
      setStep((current) => Math.min(steps.length - 1, current + 1));
      return;
    }
    if (password.length < 10) {
      setError('A senha deve ter pelo menos 10 caracteres.');
      return;
    }
    if (password !== passwordConfirmation) {
      setError('As senhas não coincidem.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await completeInitialPassword(password);
      setPassword('');
      setPasswordConfirmation('');
      setStep(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar sua senha.');
    } finally {
      setBusy(false);
    }
  };

  if (!currentStep) return null;

  return (
    <main className="onboarding-screen">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <header className="onboarding-header">
          <div className="onboarding-brand"><img src={appIcon} alt="" /><span>Lantern</span></div>
          <div className="onboarding-progress" aria-label={`Etapa ${step + 1} de ${steps.length}`}>
            {steps.map((item, index) => <span key={item.id} className={index <= step ? 'active' : ''} />)}
          </div>
        </header>

        <div className="onboarding-copy">
          <Text className="onboarding-eyebrow">PRIMEIRO ACESSO · ETAPA {step + 1} DE {steps.length}</Text>
          <h1 id="onboarding-title">{step === 0 ? `${firstName}, ${currentStep.title.toLocaleLowerCase('pt-BR')}` : currentStep.title}</h1>
          <p>{currentStep.description}</p>
        </div>

        <div className="onboarding-layout">
          <aside className="onboarding-preview">
            <Avatar emoji={emoji} bg={color} size={112} />
            <strong>{user?.displayName}</strong>
            <span>@{user?.username}</span>
            <small>Disponível</small>
          </aside>

          <div className="onboarding-options">
            <div className="onboarding-step-content">
            {currentStep.id === 'password' && (
              <div className="onboarding-password-step">
                <Field label="Nova senha" required hint="Use pelo menos 10 caracteres.">
                  <PasswordInput autoComplete="new-password" value={password} onChange={(_, data) => setPassword(data.value)} autoFocus />
                </Field>
                <Field label="Confirmar nova senha" required>
                  <PasswordInput autoComplete="new-password" value={passwordConfirmation} onChange={(_, data) => setPasswordConfirmation(data.value)} />
                </Field>
                <div className="onboarding-password-note">Depois de criar a senha, o acesso sem senha será desativado permanentemente.</div>
              </div>
            )}

            {currentStep.id === 'emoji' && (
              <ProfileIdentityEditor emoji={emoji} color={color} onEmojiChange={setEmoji} onColorChange={setColor} compact section="emoji" />
            )}

            {currentStep.id === 'color' && (
              <ProfileIdentityEditor emoji={emoji} color={color} onEmojiChange={setEmoji} onColorChange={setColor} compact section="color" />
            )}

            {currentStep.id === 'theme' && (
              <section className="onboarding-preference-section">
                <header><h2>Tema do aplicativo</h2><p>A alteração aparece imediatamente para você avaliar.</p></header>
                <ThemeSelector value={themeMode} onChange={setThemeMode} />
              </section>
            )}

            {currentStep.id === 'font' && (
              <section className="onboarding-preference-section">
                <header><h2>Tamanho da fonte</h2><p>Ajuste a leitura e a quantidade de conteúdo na tela.</p></header>
                <FontSizeSelector value={fontSizeMode} onChange={setFontSizeMode} />
              </section>
            )}

            {currentStep.id === 'density' && (
              <section className="onboarding-preference-section">
                <header><h2>Densidade da interface</h2><p>Escolha entre uma interface compacta, padrão ou confortável.</p></header>
                <DensitySelector value={densityMode} onChange={setDensityMode} />
              </section>
            )}

            {currentStep.id === 'startup' && (
              <div className="onboarding-startup-option">
                <div><strong>Abrir o Lantern ao iniciar o sistema</strong><span>Preferência válida somente para este computador.</span></div>
                <Switch checked={openAtLogin} disabled={!startupSettings?.supported} onChange={(_, data) => setOpenAtLogin(Boolean(data.checked))} aria-label="Abrir o Lantern ao iniciar o sistema" />
              </div>
            )}
            </div>

            {error && <div className="login-feedback" role="alert">{error}</div>}
            <div className="onboarding-actions">
              <Button appearance="secondary" icon={<ArrowLeft20Regular />} disabled={busy || step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>Voltar</Button>
              {currentStep.id === 'password' || step < steps.length - 1 ? (
                <Button appearance="primary" disabled={busy} iconPosition="after" icon={<ArrowRight20Regular />} onClick={() => void advance()}>{busy && currentStep.id === 'password' ? <><Spinner size="tiny" /> Salvando...</> : currentStep.id === 'password' ? 'Criar senha' : 'Continuar'}</Button>
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
