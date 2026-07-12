const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

if (process.platform !== 'darwin') {
  console.error('[Lantern build] Este script deve ser executado no macOS.');
  process.exit(1);
}

const dryRun = args.has('--dry-run');
const skipNativeRepair = args.has('--skip-native-repair');
const npx = 'npx';
const npm = 'npm';
const electronVersion = require(path.join(projectRoot, 'node_modules', 'electron', 'package.json')).version;

const run = (label, command, commandArgs, options = {}) => {
  console.log(`[Lantern build] ${label}`);
  console.log(`[Lantern build] $ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return;
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || projectRoot,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} falhou (exit=${result.status ?? 'desconhecido'})`);
  }
};

const prepareUniversalMacNativeModule = () => {
  const moduleDir = path.join(projectRoot, 'node_modules', 'better-sqlite3');
  const prebuildInstall = path.join(projectRoot, 'node_modules', '.bin', 'prebuild-install');
  if (!fs.existsSync(moduleDir) || !fs.existsSync(prebuildInstall)) return;
  run(
    'Preparando SQLite macOS x64 para o cliente universal',
    prebuildInstall,
    [
      '--runtime=electron',
      `--target=${electronVersion}`,
      '--arch=x64',
      '--platform=darwin',
      '--force'
    ],
    { cwd: moduleDir }
  );
};

try {
  run('Build do renderer', npm, ['run', 'build:renderer']);
  run('Build do cliente Electron', npm, ['run', 'build:electron']);
  run('Build do Relay de terminal', npm, ['run', 'build:relay']);
  run('Build da interface do Relay', npm, ['run', 'build:relay-ui']);

  prepareUniversalMacNativeModule();
  run('Cliente macOS universal', npx, ['--yes', 'electron-builder', '--mac', '--universal', '--publish', 'never']);
  run('Cliente Windows x64', npx, ['--yes', 'electron-builder', '--win', '--x64', '--publish', 'never']);
  run('Cliente Linux x64', npx, ['--yes', 'electron-builder', '--linux', '--x64', '--publish', 'never']);

  run('Relay UI macOS universal', npx, ['--yes', 'electron-builder', '--config', 'electron-builder.relay-ui.json', '--mac', '--universal', '--publish', 'never']);
  run('Relay UI Windows x64', npx, ['--yes', 'electron-builder', '--config', 'electron-builder.relay-ui.json', '--win', '--x64', '--publish', 'never']);
  run('Relay UI Linux x64', npx, ['--yes', 'electron-builder', '--config', 'electron-builder.relay-ui.json', '--linux', '--x64', '--publish', 'never']);

  const relayMacTarget = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  run('Relay de terminal macOS', process.execPath, ['./scripts/build-relay-bin.cjs', relayMacTarget]);
  run('Relay de terminal Windows x64', process.execPath, ['./scripts/build-relay-bin.cjs', 'win']);
  run('Relay de terminal Linux x64', process.execPath, ['./scripts/build-relay-bin.cjs', 'linux']);

  if (!skipNativeRepair) {
    run('Restaurando dependências nativas do macOS', npm, ['run', 'rebuild:native']);
  }
  console.log('[Lantern build] Concluído.');
} catch (error) {
  console.error(`[Lantern build] ERRO: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
