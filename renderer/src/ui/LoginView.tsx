import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Spinner,
  Switch
} from '@fluentui/react-components';
import {
  ArrowClockwise20Regular,
  CheckmarkCircle20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
  ErrorCircle20Regular,
  Info20Regular,
  Search20Regular,
  Warning20Regular
} from '@fluentui/react-icons';
import { ClientLocale, ClientRelayConfig, RelayConnectionMode, ipcClient } from '../api/ipcClient';
import { translate } from '../i18n';
import { useLanternStore } from '../state/store';
import appIcon from '../../../assets/icon.png';
import {
  describeLoginError,
  LoginFeedbackState,
  readableLoginError
} from './loginErrorFeedback';

export function LoginView() {
  const authState = useLanternStore((state) => state.authState);
  const login = useLanternStore((state) => state.login);
  const register = useLanternStore((state) => state.register);
  const [locale] = useState<ClientLocale>(() => {
    const stored = window.localStorage.getItem('lantern.locale');
    if (stored === 'pt-BR' || stored === 'en' || stored === 'es') return stored;
    const detected = navigator.language.toLowerCase();
    return detected.startsWith('pt') ? 'pt-BR' : detected.startsWith('es') ? 'es' : 'en';
  });
  const [mode, setMode] = useState<RelayConnectionMode>(authState?.relay.mode || 'local-auto');
  const [host, setHost] = useState(authState?.relay.host || '');
  const [port, setPort] = useState(String(authState?.relay.port || 43190));
  const [secure, setSecure] = useState(authState?.relay.secure || false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [feedback, setFeedback] = useState<LoginFeedbackState | null>(() =>
    authState?.connectionError
      ? describeLoginError(new Error(authState.connectionError), authState.relay.mode, false)
      : null
  );
  const [showConnectionValidation, setShowConnectionValidation] = useState(false);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetUsername, setResetUsername] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetStatus, setResetStatus] = useState<'idle' | 'pending' | 'approved' | 'rejected' | 'expired'>('idle');
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetFeedback, setResetFeedback] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const connectionRef = useRef<HTMLElement | null>(null);
  const t = useMemo(() => (key: Parameters<typeof translate>[1]) => translate(locale, key), [locale]);

  const discover = async () => {
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setShowConnectionValidation(true);
      setFeedback({
        title: 'Porta inválida',
        message: 'Informe uma porta entre 1 e 65535.',
        tone: 'warning',
        action: 'review-connection'
      });
      return;
    }
    setDiscovering(true);
    setFeedback(null);
    try {
      const relays = await ipcClient.discoverRelays(portNumber);
      const relay = relays[0];
      if (!relay) {
        setFeedback({
          title: 'Nenhum Relay encontrado',
          message: 'Confirme que o Relay está aberto neste computador ou na mesma rede. Verifique também o firewall e tente novamente.',
          tone: 'warning',
          action: 'discover'
        });
        return;
      }
      setHost(relay.host);
      setPort(String(relay.port));
      setSecure(relay.secure);
      setShowConnectionValidation(false);
      setFeedback({
        title: t('found'),
        message: `${relay.secure ? 'Conexão segura' : 'Conexão local'} em ${relay.host}:${relay.port}. Você já pode entrar.`,
        tone: 'success',
        action: null
      });
    } catch (error) {
      setFeedback({
        title: 'Falha ao procurar o Relay',
        message: readableLoginError(error, 'Não foi possível procurar o Relay nesta rede.'),
        tone: 'error',
        action: 'discover'
      });
    } finally {
      setDiscovering(false);
    }
  };

  const currentRelay = (): ClientRelayConfig => ({
    mode,
    host,
    port: Number(port) || 43190,
    secure: mode === 'external-manual' ? true : secure
  });

  const connectionErrors = useMemo(() => {
    const portNumber = Number(port);
    const portError = !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535
      ? 'Informe uma porta entre 1 e 65535.'
      : '';
    let hostError = '';
    if (mode !== 'local-auto') {
      if (!host.trim()) hostError = 'Informe o endereço do Relay.';
      else if (/^(?:ws|wss|http|https):\/\//iu.test(host.trim())) {
        hostError = 'Informe somente o nome ou IP, sem ws:// ou https://.';
      } else if (/[/?#]/u.test(host.trim())) {
        hostError = 'O endereço não deve conter caminho, parâmetros ou barras.';
      }
    }
    return { hostError, portError };
  }, [host, mode, port]);

  const reviewConnection = () => {
    setConnectionExpanded(true);
    setShowConnectionValidation(true);
    window.requestAnimationFrame(() => {
      const selector = connectionErrors.hostError ? 'input:not([inputmode="numeric"])' : 'input[inputmode="numeric"]';
      connectionRef.current?.querySelector<HTMLInputElement>(selector)?.focus();
    });
  };

  const checkResetStatus = async () => {
    if (!resetToken) return;
    try {
      const status = await ipcClient.getPasswordResetStatus(resetToken);
      if (status === 'approved') {
        setResetStatus('approved');
        setResetFeedback('Solicitação aprovada. Defina sua nova senha.');
      } else if (status === 'rejected') {
        setResetStatus('rejected');
        setResetFeedback('A solicitação foi rejeitada pelo administrador.');
      } else if (status === 'expired' || status === 'invalid' || status === 'consumed') {
        setResetStatus('expired');
        setResetFeedback('A solicitação expirou. Envie uma nova solicitação.');
      }
    } catch (error) {
      setResetFeedback(readableLoginError(error, 'Não foi possível consultar a solicitação.'));
    }
  };

  useEffect(() => {
    if (!forgotOpen || resetStatus !== 'pending' || !resetToken) return;
    const timer = window.setInterval(() => void checkResetStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [forgotOpen, resetStatus, resetToken]);

  const requestReset = async () => {
    if (!resetUsername.trim()) {
      setResetFeedback('Informe seu usuário para continuar.');
      return;
    }
    setResetBusy(true);
    setResetFeedback('');
    try {
      const result = await ipcClient.requestPasswordReset({ relay: currentRelay(), username: resetUsername });
      setResetToken(result.requestToken);
      setResetStatus('pending');
      setResetFeedback('Solicitação enviada. Aguarde a aprovação do administrador.');
    } catch (error) {
      setResetFeedback(readableLoginError(error, 'Não foi possível enviar a solicitação.'));
    } finally {
      setResetBusy(false);
    }
  };

  const completeReset = async () => {
    if (resetPassword.length < 10) return setResetFeedback('A nova senha deve ter pelo menos 10 caracteres.');
    if (resetPassword !== resetPasswordConfirm) return setResetFeedback('As senhas não coincidem.');
    setResetBusy(true);
    try {
      await ipcClient.completePasswordReset({
        username: resetUsername,
        requestToken: resetToken,
        newPassword: resetPassword
      });
      setForgotOpen(false);
      setPassword('');
      setFeedback({
        title: 'Senha redefinida',
        message: 'Entre usando a nova senha.',
        tone: 'success',
        action: null
      });
    } catch (error) {
      setResetFeedback(readableLoginError(error, 'Não foi possível redefinir a senha.'));
    } finally {
      setResetBusy(false);
    }
  };

  const attemptAuthentication = async () => {
    if (connectionErrors.hostError || connectionErrors.portError) {
      setShowConnectionValidation(true);
      setFeedback({
        title: 'Revise a conexão',
        message: connectionErrors.hostError || connectionErrors.portError,
        tone: 'warning',
        action: 'review-connection'
      });
      reviewConnection();
      return;
    }
    setBusy(true);
    setFeedback(null);
    const relay = currentRelay();
    try {
      if (creating) {
        await register({ relay, username, displayName, password, locale });
      } else {
        await login({ relay, username, password, rememberMe });
      }
    } catch (error) {
      setFeedback(describeLoginError(error, mode, creating));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void attemptAuthentication();
  };

  const connectionLabel = mode === 'local-auto'
    ? t('localAuto')
    : `${secure || mode === 'external-manual' ? 'wss' : 'ws'}://${host || 'relay'}:${port}`;

  const FeedbackIcon = feedback?.tone === 'error'
    ? ErrorCircle20Regular
    : feedback?.tone === 'warning'
      ? Warning20Regular
      : feedback?.tone === 'success'
        ? CheckmarkCircle20Regular
        : Info20Regular;

  return <main className={`login-screen login-screen-v2 ${creating ? 'is-creating' : ''} ${feedback ? 'has-feedback' : ''}`}>
    <section className="login-brand login-brand-v2">
      <div className="login-identity">
        <img className="login-app-icon" src={appIcon} alt="" />
      </div>
    </section>

    <form className="login-card login-card-v2" onSubmit={submit}>
      <header className="login-card-header">
        <div><span className="login-eyebrow">{creating ? 'NOVA CONTA' : 'BEM-VINDO'}</span><h2>{creating ? 'Criar sua conta' : t('welcome')}</h2></div>
      </header>

      <div className="login-account-tabs" role="tablist" aria-label="Acesso">
        <button type="button" className={!creating ? 'active' : ''} onClick={() => { setCreating(false); setFeedback(null); }}>Entrar</button>
        <button type="button" className={creating ? 'active' : ''} onClick={() => { setCreating(true); setFeedback(null); }}>Criar conta</button>
      </div>

      <div className="login-fields">
        {creating && <Field label={t('displayName')} required><Input autoFocus autoComplete="name" value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="Como você quer ser chamado" /></Field>}
        <Field label={t('username')} required><Input autoFocus={!creating} autoComplete="username" value={username} onChange={(_, d) => setUsername(d.value)} placeholder="seu.usuario" /></Field>
        <Field label={t('password')} required={creating}>
          <Input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(_, d) => setPassword(d.value)} />
          <small className="login-field-hint">{creating ? 'Use pelo menos 10 caracteres.' : 'No primeiro acesso de uma conta criada pelo administrador, deixe em branco.'}</small>
        </Field>
      </div>

      <section
        ref={connectionRef}
        className={`login-connection ${connectionExpanded ? 'expanded' : 'collapsed'} ${showConnectionValidation && (connectionErrors.hostError || connectionErrors.portError) ? 'invalid' : ''}`}
        aria-label="Conexão com o Relay"
      >
        <button
          type="button"
          className="login-connection-trigger"
          aria-expanded={connectionExpanded}
          aria-controls="login-relay-options"
          onClick={() => setConnectionExpanded((expanded) => !expanded)}
        >
          <span><strong>Conexão com o Relay</strong><small>{connectionLabel}</small></span>
          {connectionExpanded ? <ChevronUp20Regular aria-hidden="true" /> : <ChevronDown20Regular aria-hidden="true" />}
        </button>
        {connectionExpanded && <div id="login-relay-options" className="login-connection-body">
          <div className="login-mode-tabs">
            {(['local-auto', 'local-manual', 'external-manual'] as RelayConnectionMode[]).map((value) =>
              <Button
                key={value}
                type="button"
                appearance={mode === value ? 'primary' : 'subtle'}
                onClick={() => {
                  setMode(value);
                  setFeedback(null);
                  setShowConnectionValidation(false);
                  if (value === 'local-auto' && connectionErrors.portError) setPort('43190');
                }}
              >
                {t(value === 'local-auto' ? 'localAuto' : value === 'local-manual' ? 'localManual' : 'external')}
              </Button>)}
          </div>
          {mode === 'local-auto' && <Button type="button" onClick={() => void discover()} disabled={discovering}>
            {discovering ? <><Spinner size="tiny" /> {t('searching')}</> : t('discover')}
          </Button>}
          {mode !== 'local-auto' && <div className="login-address-row">
            <Field
              label={t('host')}
              required
              validationState={showConnectionValidation && connectionErrors.hostError ? 'error' : 'none'}
              validationMessage={showConnectionValidation ? connectionErrors.hostError : ''}
            >
              <Input
                value={host}
                onChange={(_, d) => {
                  setHost(d.value);
                  setShowConnectionValidation(false);
                  if (feedback?.action === 'review-connection') setFeedback(null);
                }}
                placeholder="relay.exemplo.com"
              />
            </Field>
            <Field
              label={t('port')}
              required
              validationState={showConnectionValidation && connectionErrors.portError ? 'error' : 'none'}
              validationMessage={showConnectionValidation ? connectionErrors.portError : ''}
            >
              <Input
                value={port}
                onChange={(_, d) => {
                  setPort(d.value.replace(/[^0-9]/gu, ''));
                  setShowConnectionValidation(false);
                  if (feedback?.action === 'review-connection') setFeedback(null);
                }}
                inputMode="numeric"
              />
            </Field>
          </div>}
          {mode === 'local-manual' && <Switch checked={secure} onChange={(_, d) => setSecure(d.checked)} label={t('secure')} />}
        </div>}
      </section>

      {!creating && <div className="login-session-options">
        <Checkbox
          checked={rememberMe}
          onChange={(_, data) => setRememberMe(data.checked === true)}
          label="Manter-me conectado"
        />
        <button
          type="button"
          className="login-link-button"
          onClick={() => {
            setResetUsername(username);
            setResetToken('');
            setResetStatus('idle');
            setResetPassword('');
            setResetPasswordConfirm('');
            setResetFeedback('');
            setForgotOpen(true);
          }}
        >Esqueci minha senha</button>
      </div>}

      {creating && <small className="login-account-hint">{t('accountHint')}</small>}
      {feedback && (
        <div
          className={`login-feedback ${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <FeedbackIcon className="login-feedback-icon" aria-hidden="true" />
          <div className="login-feedback-content">
            <strong>{feedback.title}</strong>
            <span>{feedback.message}</span>
            {feedback.action && (
              <div className="login-feedback-actions">
                {feedback.action === 'discover' ? (
                  <Button
                    type="button"
                    appearance="secondary"
                    size="small"
                    icon={<Search20Regular />}
                    disabled={discovering || busy}
                    onClick={() => void discover()}
                  >
                    Procurar novamente
                  </Button>
                ) : feedback.action === 'review-connection' ? (
                  <Button
                    type="button"
                    appearance="secondary"
                    size="small"
                    onClick={reviewConnection}
                  >
                    Revisar conexão
                  </Button>
                ) : (
                  <Button
                    type="button"
                    appearance="secondary"
                    size="small"
                    icon={<ArrowClockwise20Regular />}
                    disabled={busy}
                    onClick={() => void attemptAuthentication()}
                  >
                    Tentar novamente
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <Button className="login-submit" type="submit" appearance="primary" size="large" disabled={busy || discovering || !username.trim() || (creating && (!displayName.trim() || password.length < 10))}>
        {busy ? <><Spinner size="tiny" /> {t('entering')}</> : t(creating ? 'createAccount' : 'enter')}
      </Button>
      <p className="login-privacy">Ao continuar, você se conecta ao servidor selecionado.</p>
    </form>

    <Dialog open={forgotOpen} onOpenChange={(_, data) => setForgotOpen(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Redefinir senha</DialogTitle>
          <DialogContent className="password-reset-dialog-content">
            <p>Informe seu usuário. Um administrador precisará aprovar a solicitação antes da alteração.</p>
            <Field label="Usuário" required>
              <Input
                value={resetUsername}
                disabled={resetStatus === 'pending' || resetStatus === 'approved'}
                onChange={(_, data) => setResetUsername(data.value)}
                autoComplete="username"
              />
            </Field>
            {resetStatus === 'approved' && <>
              <Field label="Nova senha" required>
                <Input type="password" value={resetPassword} onChange={(_, data) => setResetPassword(data.value)} autoComplete="new-password" />
              </Field>
              <Field label="Confirmar nova senha" required>
                <Input type="password" value={resetPasswordConfirm} onChange={(_, data) => setResetPasswordConfirm(data.value)} autoComplete="new-password" />
              </Field>
              <small>Use pelo menos 10 caracteres.</small>
            </>}
            {resetFeedback && <div className="login-feedback" role="status">{resetFeedback}</div>}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setForgotOpen(false)}>Cancelar</Button>
            {resetStatus === 'idle' || resetStatus === 'rejected' || resetStatus === 'expired' ? (
              <Button appearance="primary" disabled={resetBusy || !resetUsername.trim()} onClick={() => void requestReset()}>
                {resetBusy ? <Spinner size="tiny" /> : 'Enviar solicitação'}
              </Button>
            ) : resetStatus === 'pending' ? (
              <Button appearance="primary" disabled={resetBusy} onClick={() => void checkResetStatus()}>
                Verificar aprovação
              </Button>
            ) : (
              <Button appearance="primary" disabled={resetBusy || resetPassword.length < 10 || resetPassword !== resetPasswordConfirm} onClick={() => void completeReset()}>
                Salvar nova senha
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  </main>;
}
