export type ThemeMode = 'system' | 'light' | 'dark';
export type FontSizeMode = 'small' | 'medium' | 'large';
export type DensityMode = 'compact' | 'standard' | 'comfortable';

export interface AppearancePreferences {
  themeMode: ThemeMode;
  fontSizeMode: FontSizeMode;
  densityMode: DensityMode;
}

export interface AppearanceAccountScope {
  userId: string;
  relay: {
    mode: 'local-auto' | 'local-manual' | 'external-manual';
    host: string;
    port: number;
    secure: boolean;
  };
  endpoint?: string | null;
}

export interface AppearanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = Object.freeze({
  themeMode: 'system',
  fontSizeMode: 'medium',
  densityMode: 'standard'
});

const STORAGE_PREFIX = 'lantern.appearance.v2';
const MIGRATION_OWNER_KEY = `${STORAGE_PREFIX}.migration-owner`;
const LEGACY_THEME_KEY = 'lantern.theme';
const LEGACY_FONT_SIZE_KEY = 'lantern.font-size';
const LEGACY_DENSITY_KEY = 'lantern.density';

const cloneDefaultAppearance = (): AppearancePreferences => ({ ...DEFAULT_APPEARANCE });

const normalizedPort = (value: number): number => {
  const port = Math.trunc(Number(value));
  return Number.isFinite(port) && port >= 1 && port <= 65_535 ? port : 43_190;
};

const normalizedManualHost = (scope: AppearanceAccountScope): string => {
  const configured = scope.relay.host.trim().toLowerCase();
  if (configured) return configured;
  try {
    return scope.endpoint ? new URL(scope.endpoint).hostname.toLowerCase() : 'relay';
  } catch {
    return 'relay';
  }
};

export const appearanceStorageKey = (scope: AppearanceAccountScope): string | null => {
  const userId = scope.userId.trim();
  if (!userId) return null;
  const port = normalizedPort(scope.relay.port);
  const relayScope =
    scope.relay.mode === 'local-auto'
      ? `local-auto:${port}`
      : `${scope.relay.mode}:${scope.relay.secure ? 'wss' : 'ws'}:${normalizedManualHost(scope)}:${port}`;
  return `${STORAGE_PREFIX}:${encodeURIComponent(relayScope)}:${encodeURIComponent(userId)}`;
};

export const normalizeAppearance = (value: unknown): AppearancePreferences | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AppearancePreferences>;
  if (
    candidate.themeMode !== 'system' &&
    candidate.themeMode !== 'light' &&
    candidate.themeMode !== 'dark'
  ) return null;
  if (
    candidate.fontSizeMode !== 'small' &&
    candidate.fontSizeMode !== 'medium' &&
    candidate.fontSizeMode !== 'large'
  ) return null;
  if (
    candidate.densityMode !== 'compact' &&
    candidate.densityMode !== 'standard' &&
    candidate.densityMode !== 'comfortable'
  ) return null;
  return {
    themeMode: candidate.themeMode,
    fontSizeMode: candidate.fontSizeMode,
    densityMode: candidate.densityMode
  };
};

const readLegacyAppearance = (storage: AppearanceStorage): AppearancePreferences => {
  let themeMode: string | null = null;
  let fontSizeMode: string | null = null;
  let densityMode: string | null = null;
  try {
    themeMode = storage.getItem(LEGACY_THEME_KEY);
    fontSizeMode = storage.getItem(LEGACY_FONT_SIZE_KEY);
    densityMode = storage.getItem(LEGACY_DENSITY_KEY);
  } catch {
    return cloneDefaultAppearance();
  }
  return {
    themeMode:
      themeMode === 'light' || themeMode === 'dark' || themeMode === 'system'
        ? themeMode
        : DEFAULT_APPEARANCE.themeMode,
    fontSizeMode:
      fontSizeMode === 'small' || fontSizeMode === 'medium' || fontSizeMode === 'large'
        ? fontSizeMode
        : DEFAULT_APPEARANCE.fontSizeMode,
    densityMode:
      densityMode === 'compact' || densityMode === 'standard' || densityMode === 'comfortable'
        ? densityMode
        : DEFAULT_APPEARANCE.densityMode
  };
};

const safelyWrite = (
  storage: AppearanceStorage,
  key: string,
  appearance: AppearancePreferences
): boolean => {
  try {
    storage.setItem(key, JSON.stringify(appearance));
    return true;
  } catch {
    return false;
  }
};

const claimLegacyMigration = (
  storage: AppearanceStorage,
  ownerKey: string,
  migrationOwner: string | null
): void => {
  if (migrationOwner) return;
  try {
    storage.setItem(MIGRATION_OWNER_KEY, ownerKey);
  } catch {
    // A limpeza abaixo ainda evita que outra conta herde os mesmos valores.
  }
  try {
    storage.removeItem?.(LEGACY_THEME_KEY);
    storage.removeItem?.(LEGACY_FONT_SIZE_KEY);
    storage.removeItem?.(LEGACY_DENSITY_KEY);
  } catch {
    // Armazenamentos restritos podem impedir apenas a limpeza das chaves.
  }
};

export const readAppearanceForAccount = (
  storage: AppearanceStorage,
  scope: AppearanceAccountScope,
  options: { migrateLegacy: boolean }
): AppearancePreferences => {
  const key = appearanceStorageKey(scope);
  if (!key) return cloneDefaultAppearance();

  let storedAppearance: AppearancePreferences | null = null;
  try {
    const stored = storage.getItem(key);
    if (stored) {
      storedAppearance = normalizeAppearance(JSON.parse(stored));
    }
  } catch {
    // Uma entrada corrompida não pode impedir o Lantern de iniciar.
  }

  let migrationOwner: string | null = null;
  try {
    migrationOwner = storage.getItem(MIGRATION_OWNER_KEY);
  } catch {
    return storedAppearance || cloneDefaultAppearance();
  }

  // Uma conta que já possui a preferência v2 não deve ser sobrescrita pelo
  // legado. Quando ela já concluiu o onboarding, apenas consome e limpa a
  // migração para impedir que outra conta herde as antigas chaves globais.
  if (storedAppearance) {
    if (options.migrateLegacy) {
      claimLegacyMigration(storage, key, migrationOwner);
    }
    return storedAppearance;
  }

  const appearance =
    options.migrateLegacy && !migrationOwner
      ? readLegacyAppearance(storage)
      : cloneDefaultAppearance();
  const saved = safelyWrite(storage, key, appearance);

  if (saved && options.migrateLegacy && !migrationOwner) {
    claimLegacyMigration(storage, key, migrationOwner);
  }
  return appearance;
};

export const persistAppearanceForAccount = (
  storage: AppearanceStorage,
  scope: AppearanceAccountScope,
  appearance: AppearancePreferences
): boolean => {
  const key = appearanceStorageKey(scope);
  const normalized = normalizeAppearance(appearance);
  if (!key || !normalized) return false;
  return safelyWrite(storage, key, normalized);
};
