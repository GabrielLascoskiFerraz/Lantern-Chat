import {
  Desktop20Regular,
  TextFont20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular
} from '@fluentui/react-icons';

export type ThemeMode = 'system' | 'light' | 'dark';
export type FontSizeMode = 'small' | 'medium' | 'large';

export const themeModeLabel = (mode: ThemeMode): string =>
  mode === 'system' ? 'Sistema' : mode === 'light' ? 'Claro' : 'Escuro';

export const fontSizeModeLabel = (mode: FontSizeMode): string =>
  mode === 'small' ? 'Pequena' : mode === 'medium' ? 'Padrão' : 'Grande';

export const ThemeSelector = ({
  value,
  onChange
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) => (
  <div className="settings-theme-options" role="group" aria-label="Tema do aplicativo">
    <button type="button" className={value === 'system' ? 'active' : ''} aria-pressed={value === 'system'} onClick={() => onChange('system')}>
      <span className="settings-theme-preview system" aria-hidden="true"><span /><span /></span>
      <span className="settings-theme-option-label"><Desktop20Regular aria-hidden="true" /><span><strong>Sistema</strong><small>Acompanha o dispositivo</small></span></span>
    </button>
    <button type="button" className={value === 'light' ? 'active' : ''} aria-pressed={value === 'light'} onClick={() => onChange('light')}>
      <span className="settings-theme-preview light" aria-hidden="true"><span /></span>
      <span className="settings-theme-option-label"><WeatherSunny20Regular aria-hidden="true" /><span><strong>Claro</strong><small>Superfícies luminosas</small></span></span>
    </button>
    <button type="button" className={value === 'dark' ? 'active' : ''} aria-pressed={value === 'dark'} onClick={() => onChange('dark')}>
      <span className="settings-theme-preview dark" aria-hidden="true"><span /></span>
      <span className="settings-theme-option-label"><WeatherMoon20Regular aria-hidden="true" /><span><strong>Escuro</strong><small>Menos brilho na tela</small></span></span>
    </button>
  </div>
);

export const FontSizeSelector = ({
  value,
  onChange
}: {
  value: FontSizeMode;
  onChange: (mode: FontSizeMode) => void;
}) => (
  <div className="settings-font-size-options" role="group" aria-label="Tamanho da fonte do aplicativo">
    {([
      ['small', 'Pequena', 'Mais conteúdo na tela', 'Aa'],
      ['medium', 'Padrão', 'Equilíbrio recomendado', 'Aa'],
      ['large', 'Grande', 'Leitura mais confortável', 'Aa']
    ] as const).map(([mode, label, description, sample]) => (
      <button key={mode} type="button" className={value === mode ? 'active' : ''} aria-pressed={value === mode} onClick={() => onChange(mode)}>
        <span className={`settings-font-sample ${mode}`} aria-hidden="true">{sample}</span>
        <span className="settings-theme-option-label"><TextFont20Regular aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span></span>
      </button>
    ))}
  </div>
);
