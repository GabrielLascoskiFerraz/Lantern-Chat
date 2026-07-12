import { FormEvent, useMemo, useState } from 'react';
import { Button, Field, Input, Select, Spinner, Switch } from '@fluentui/react-components';
import { ClientLocale, ClientRelayConfig, RelayConnectionMode, ipcClient } from '../api/ipcClient';
import { localeLabels, translate } from '../i18n';
import { useLanternStore } from '../state/store';

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
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [feedback, setFeedback] = useState('');
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFeedback('');
    const relay: ClientRelayConfig = {
      mode,
      host,
      port: Number(port) || 43190,
      secure: mode === 'external-manual' ? true : secure
    };
    try {
      if (creating) {
        await register({ relay, username, displayName, password, locale });
      } else {
        await login({ relay, username, password });
      }
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Falha ao entrar.');
    } finally {
      setBusy(false);
    }
  };

  return <main className="login-screen">
    <section className="login-brand">
      <span className="login-mark">L</span>
      <div><strong>Lantern</strong><span>Central</span></div>
      <h1>{t('welcome')}</h1><p>{t('subtitle')}</p>
    </section>
    <form className="login-card" onSubmit={submit}>
      <Select value={locale} onChange={(_, data) => changeLocale(data.value as ClientLocale)}>
        {Object.entries(localeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select>
      <h2>{t('relay')}</h2>
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
      {mode !== 'external-manual' && <Switch checked={secure} onChange={(_, d) => setSecure(d.checked)} label={t('secure')} />}
      {creating && <Field label={t('displayName')} required><Input autoComplete="name" value={displayName} onChange={(_, d) => setDisplayName(d.value)} /></Field>}
      <Field label={t('username')} required><Input autoComplete="username" value={username} onChange={(_, d) => setUsername(d.value)} /></Field>
      <Field label={t('password')} required><Input type="password" autoComplete="current-password" value={password} onChange={(_, d) => setPassword(d.value)} /></Field>
      {creating && <small className="login-account-hint">{t('accountHint')}</small>}
      {feedback && <div className="login-feedback" role="status">{feedback}</div>}
      <Button type="submit" appearance="primary" size="large" disabled={busy || !username.trim() || !password || (creating && !displayName.trim())}>
        {busy ? t('entering') : t(creating ? 'createAccount' : 'enter')}
      </Button>
      <Button type="button" appearance="subtle" onClick={() => { setCreating((value) => !value); setFeedback(''); }}>
        {t(creating ? 'haveAccount' : 'createAccount')}
      </Button>
    </form>
  </main>;
}
