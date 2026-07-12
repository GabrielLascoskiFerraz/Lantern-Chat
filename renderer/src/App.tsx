import { Component, ErrorInfo, ReactNode, useEffect, useMemo } from 'react';
import {
  FluentProvider,
  Spinner,
  createDarkTheme,
  createLightTheme,
  Theme
} from '@fluentui/react-components';
import { ipcClient } from './api/ipcClient';
import { Shell } from './ui/Shell';
import { LoginView } from './ui/LoginView';
import { useLanternStore } from './state/store';

const brandPalette = {
  10: '#06122b',
  20: '#0b214f',
  30: '#12306f',
  40: '#1a4090',
  50: '#2451b3',
  60: '#2f62d4',
  70: '#4a78df',
  80: '#6690e8',
  90: '#87aaef',
  100: '#abc5f5',
  110: '#cde0fa',
  120: '#eaf2ff',
  130: '#f3f8ff',
  140: '#f8fbff',
  150: '#fcfdff',
  160: '#ffffff'
};

const lightTheme = createLightTheme(brandPalette);
const darkTheme = createDarkTheme(brandPalette);

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Lantern] erro fatal na interface:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="loading-screen loading-screen-error">
          <div className="startup-error-card">
            <strong>Não foi possível renderizar a interface</strong>
            <span>O Lantern manteve o processo ativo. Recarregue a interface para tentar novamente.</span>
            <button type="button" onClick={() => this.setState({ error: null })}>
              Tentar novamente
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const configureTheme = (theme: Theme): Theme => ({
  ...theme,
  fontFamilyBase: '"Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
  borderRadiusSmall: '4px',
  borderRadiusMedium: '6px',
  borderRadiusLarge: '8px'
});

export default function App() {
  const loadInitial = useLanternStore((state) => state.loadInitial);
  const resolvedTheme = useLanternStore((state) => state.resolvedTheme);
  const ready = useLanternStore((state) => state.ready);
  const authState = useLanternStore((state) => state.authState);
  const setSystemDark = useLanternStore((state) => state.setSystemDark);
  const platform =
    typeof window !== 'undefined' && window.lantern ? ipcClient.getPlatform() : 'linux';

  const theme = useMemo(
    () => configureTheme(resolvedTheme === 'dark' ? darkTheme : lightTheme),
    [resolvedTheme]
  );

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
    };
    setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [setSystemDark]);

  useEffect(() => {
    document.documentElement.setAttribute('data-platform', platform);
  }, [platform]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    const locale = authState?.user?.locale || window.localStorage.getItem('lantern.locale') || 'pt-BR';
    document.documentElement.lang = locale;
    window.localStorage.setItem('lantern.locale', locale);
  }, [authState?.user?.locale]);

  return (
    <FluentProvider theme={theme} className="app-root">
      <AppErrorBoundary>
        {!ready ? <div className="loading-screen"><Spinner /></div> : authState?.authenticated ? <Shell /> : <LoginView />}
      </AppErrorBoundary>
    </FluentProvider>
  );
}
