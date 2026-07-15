import { FormEvent, useEffect, useMemo, useState } from 'react';
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
  Select,
  Spinner,
  Switch
} from '@fluentui/react-components';
import { ClientLocale, ClientRelayConfig, RelayConnectionMode, ipcClient } from '../api/ipcClient';
import { localeLabels, translate } from '../i18n';
import { useLanternStore } from '../state/store';
import appIcon from '../../../assets/icon.png';

const readableError = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
};

export function LoginView() {
  const authState = useLanternStore((state) => state.authState);
  const login = useLanternStore((state) => state.login);
  const register = useLanternStore((state) => state.register);
  const [locale, setLocale] = useState<ClientLocale>(() =>
    (window.localStorage.getItem('lantern.locale') as ClientLocale) || 'pt-BR'
  );
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
  const [feedback, setFeedback] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetUsername, setResetUsername] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetStatus, setResetStatus] = useState<'idle' | 'pending' | 'approved' | 'rejected' | 'expired'>('idle');
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetFeedback, setResetFeedback] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const t = useMemo(() => (key: Parameters<typeof translate>[1]) => translate(locale, key), [locale]);

  const changeLocale = (next: ClientLocale) => {
    setLocale(next);
    window.localStorage.setItem('lantern.locale', next);
  };

  const discover = async () => {
    setDiscovering(true);
    setFeedback('');
    try {
      const relays = await ipcClient.discoverRelays(Number(port) || 43190);
      const relay = relays[0];
      if (!relay) return setFeedback(t('noRelay'));
      setHost(relay.host);
      setPort(String(relay.port));
      setSecure(relay.secure);
      setFeedback(`${t('found')}: ${relay.host}:${relay.port}`);
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
      setResetFeedback(readableError(error, 'Não foi possível consultar a solicitação.'));
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
      setResetFeedback(readableError(error, 'Não foi possível enviar a solicitação.'));
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
      setFeedback('Senha redefinida. Entre usando a nova senha.');
    } catch (error) {
      setResetFeedback(readableError(error, 'Não foi possível redefinir a senha.'));
    } finally {
      setResetBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    const relay = currentRelay();
    try {
      if (creating) {
        await register({ relay, username, displayName, password, locale });
      } else {
        await login({ relay, username, password, rememberMe });
      }
    } catch (error) {
      setFeedback(readableError(error, 'Falha ao entrar.'));
    } finally {
      setBusy(false);
    }
  };

  const connectionLabel = mode === 'local-auto'
    ? t('localAuto')
    : `${secure || mode === 'external-manual' ? 'wss' : 'ws'}://${host || 'relay'}:${port}`;

  return <main className="login-screen login-screen-v2">
    <section className="login-brand login-brand-v2">
      <div className="login-identity">
        <img className="login-app-icon" src={appIcon} alt="" />
        <div className="login-product"><strong>Lantern</strong></div>
      </div>
    </section>

    <form className="login-card login-card-v2" onSubmit={submit}>
      <header className="login-card-header">
        <div><span className="login-eyebrow">{creating ? 'NOVA CONTA' : 'BEM-VINDO'}</span><h2>{creating ? 'Criar sua conta' : t('welcome')}</h2></div>
        <Select aria-label="Idioma" value={locale} onChange={(_, data) => changeLocale(data.value as ClientLocale)}>
          {Object.entries(localeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
      </header>

      <div className="login-account-tabs" role="tablist" aria-label="Acesso">
        <button type="button" className={!creating ? 'active' : ''} onClick={() => { setCreating(false); setFeedback(''); }}>Entrar</button>
        <button type="button" className={creating ? 'active' : ''} onClick={() => { setCreating(true); setFeedback(''); }}>Criar conta</button>
      </div>

      <div className="login-fields">
        {creating && <Field label={t('displayName')} required><Input autoFocus autoComplete="name" value={displayName} onChange={(_, d) => setDisplayName(d.value)} placeholder="Como você quer ser chamado" /></Field>}
        <Field label={t('username')} required><Input autoFocus={!creating} autoComplete="username" value={username} onChange={(_, d) => setUsername(d.value)} placeholder="seu.usuario" /></Field>
        <Field label={t('password')} required>
          <Input type="password" autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(_, d) => setPassword(d.value)} />
          {creating && <small className="login-field-hint">Use pelo menos 10 caracteres.</small>}
        </Field>
      </div>

      <section className="login-connection" aria-label="Conexão com o Relay">
        <div className="login-connection-header"><span>Conexão com o Relay</span><small>{connectionLabel}</small></div>
        <div className="login-connection-body">
          <div className="login-mode-tabs">
            {(['local-auto', 'local-manual', 'external-manual'] as RelayConnectionMode[]).map((value) =>
              <Button key={value} type="button" appearance={mode === value ? 'primary' : 'subtle'} onClick={() => setMode(value)}>
                {t(value === 'local-auto' ? 'localAuto' : value === 'local-manual' ? 'localManual' : 'external')}
              </Button>)}
          </div>
          {mode === 'local-auto' && <Button type="button" onClick={() => void discover()} disabled={discovering}>
            {discovering ? <><Spinner size="tiny" /> {t('searching')}</> : t('discover')}
          </Button>}
          {mode !== 'local-auto' && <div className="login-address-row">
            <Field label={t('host')} required><Input value={host} onChange={(_, d) => setHost(d.value)} placeholder="relay.exemplo.com" /></Field>
            <Field label={t('port')} required><Input value={port} onChange={(_, d) => setPort(d.value)} inputMode="numeric" /></Field>
          </div>}
          {mode === 'local-manual' && <Switch checked={secure} onChange={(_, d) => setSecure(d.checked)} label={t('secure')} />}
        </div>
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
      {feedback && <div className="login-feedback" role="alert" aria-live="polite">{feedback}</div>}
      <Button className="login-submit" type="submit" appearance="primary" size="large" disabled={busy || !username.trim() || !password || (creating && (!displayName.trim() || password.length < 10))}>
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
