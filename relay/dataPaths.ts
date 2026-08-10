import path from 'node:path';

type RelayPathEnvironment = NodeJS.ProcessEnv;

/**
 * Diretório compartilhado pelo Relay UI Electron e pelo Relay headless.
 * O nome é deliberadamente estável e não depende do nome do executável.
 */
export const resolveSharedRelayDataDir = (options?: {
  platform?: NodeJS.Platform;
  env?: RelayPathEnvironment;
}): string => {
  const platform = options?.platform || process.platform;
  const env = options?.env || process.env;
  const configured = String(env.LANTERN_RELAY_DATA_DIR || '').trim();
  if (configured) return path.resolve(configured);

  const home = platform === 'win32'
    ? String(env.USERPROFILE || env.HOME || process.cwd())
    : String(env.HOME || process.cwd());
  const appData = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32'
      ? String(env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : String(env.XDG_CONFIG_HOME || path.join(home, '.config'));

  return path.join(appData, 'lantern', 'relay-data');
};
