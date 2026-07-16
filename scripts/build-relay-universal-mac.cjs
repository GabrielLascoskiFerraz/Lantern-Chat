const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist-relay');
const arm64File = path.join(distDir, 'LanternRelay-mac-arm64');
const x64File = path.join(distDir, 'LanternRelay-mac-x64');
const universalFile = path.join(distDir, 'LanternRelay-mac-universal');

if (process.platform !== 'darwin') {
  console.error('[LanternRelay build] O binário universal deve ser criado no macOS.');
  process.exit(1);
}

const run = (label, command, args) => {
  console.log(`[LanternRelay build] ${label}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} falhou (exit=${result.status ?? 'desconhecido'})`);
  }
};

try {
  run('Gerando arquitetura Apple Silicon', process.execPath, [
    './scripts/build-relay-bin.cjs',
    'mac-arm64'
  ]);
  run('Gerando arquitetura Intel', process.execPath, [
    './scripts/build-relay-bin.cjs',
    'mac-x64'
  ]);
  run('Combinando as arquiteturas com lipo', '/usr/bin/lipo', [
    '-create',
    arm64File,
    x64File,
    '-output',
    universalFile
  ]);
  fs.chmodSync(universalFile, 0o755);
  run('Validando o binário universal', '/usr/bin/lipo', ['-info', universalFile]);
  console.log(`[LanternRelay build] ok: ${universalFile}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[LanternRelay build] ERRO: ${message}`);
  process.exit(1);
}
