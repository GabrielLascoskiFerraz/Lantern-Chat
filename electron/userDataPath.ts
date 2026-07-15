import fs from 'node:fs';
import path from 'node:path';

export const prepareLanternUserDataPath = (
  appDataDir: string,
  instanceTag = ''
): string => {
  const baseDir = path.join(appDataDir, 'Lantern');
  const legacyDir = path.join(appDataDir, 'Lantern Central');
  const migrationMarker = path.join(baseDir, '.legacy-user-data-migrated-v1');

  fs.mkdirSync(baseDir, { recursive: true });
  if (fs.existsSync(legacyDir) && !fs.existsSync(migrationMarker)) {
    // force:false torna a cópia idempotente inclusive quando instâncias de
    // desenvolvimento A/B iniciam ao mesmo tempo.
    fs.cpSync(legacyDir, baseDir, {
      recursive: true,
      force: false,
      errorOnExist: false
    });
    fs.writeFileSync(migrationMarker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  }

  const normalizedTag = instanceTag.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const userDataDir = normalizedTag
    ? path.join(baseDir, `instance-${normalizedTag}`)
    : baseDir;
  fs.mkdirSync(userDataDir, { recursive: true });
  return userDataDir;
};
