const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

const showHelp = () => {
  console.log(`
Uso:
  npm run build:all:from-mac -- [opções]

Gera a partir do macOS:
  - Lantern para macOS universal, Windows x64 e Linux x64
  - Lantern Relay UI para macOS universal, Windows x64 e Linux x64

Opções:
  --dry-run             Mostra os comandos sem executá-los.
  --skip-install        Não executa npm ci quando node_modules estiver ausente.
  --skip-native-repair  Não restaura os módulos nativos para o Mac ao final.
  --win-skip-rcedit     Desativa a edição de ícone/metadados dos executáveis Windows.
  --help                Exibe esta ajuda.
`);
};

if (args.has('--help')) {
  showHelp();
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('[Lantern build] Este comando deve ser executado no macOS.');
  process.exit(1);
}

const dryRun = args.has('--dry-run');
const skipInstall = args.has('--skip-install');
const skipNativeRepair = args.has('--skip-native-repair');
const winSkipRcedit = args.has('--win-skip-rcedit');
const npm = 'npm';
const npx = 'npx';

const run = (label, command, commandArgs) => {
  console.log(`\n[Lantern build] ${label}`);
  console.log(`[Lantern build] $ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) return;

  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${label} falhou (exit=${result.status ?? 'desconhecido'})`);
  }
};

const ensureDependencies = () => {
  if (fs.existsSync(path.join(projectRoot, 'node_modules'))) return;
  if (skipInstall) {
    throw new Error('node_modules não existe e --skip-install foi informado. Execute npm ci.');
  }
  run('Instalando dependências', npm, ['ci']);
};

const windowsArgs = (config) => {
  const result = ['--yes', 'electron-builder'];
  if (config) result.push('--config', config);
  result.push('--win', '--x64', '--publish', 'never');
  if (winSkipRcedit) result.push('-c.win.signAndEditExecutable=false');
  return result;
};

const builderArgs = (config, platformArgs) => {
  const result = ['--yes', 'electron-builder'];
  if (config) result.push('--config', config);
  return [...result, ...platformArgs, '--publish', 'never'];
};

const requirePath = (label, targetPath) => {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} não foi gerado: ${targetPath}`);
  }
  console.log(`[Lantern build] OK: ${label} -> ${path.relative(projectRoot, targetPath)}`);
};

const requireMatch = (label, directory, pattern) => {
  if (!fs.existsSync(directory)) {
    throw new Error(`${label}: diretório de saída não foi criado: ${directory}`);
  }
  const match = fs.readdirSync(directory).find((name) => pattern.test(name));
  if (!match) {
    throw new Error(`${label} não foi encontrado em ${directory}`);
  }
  console.log(`[Lantern build] OK: ${label} -> ${path.relative(projectRoot, path.join(directory, match))}`);
};

const validateArtifacts = () => {
  if (dryRun) return;
  const clientDir = path.join(projectRoot, 'dist-installers');
  const relayUiDir = path.join(projectRoot, 'dist-relay-ui-installers');

  requirePath('Lantern macOS .app universal', path.join(clientDir, 'mac-universal', 'Lantern.app'));
  requireMatch('Lantern macOS DMG universal', clientDir, /^Lantern-.*-universal\.dmg$/i);
  requirePath('Lantern Windows unpacked', path.join(clientDir, 'win-unpacked', 'Lantern.exe'));
  requireMatch('Lantern Windows instalador', clientDir, /^Lantern-Setup-.*\.exe$/i);
  requireMatch('Lantern Linux AppImage', clientDir, /^Lantern-.*\.(?:AppImage)$/i);

  requirePath('Relay UI macOS .app universal', path.join(relayUiDir, 'mac-universal', 'Lantern Relay.app'));
  requireMatch('Relay UI macOS DMG universal', relayUiDir, /^LanternRelay-.*-universal\.dmg$/i);
  requirePath('Relay UI Windows unpacked', path.join(relayUiDir, 'win-unpacked', 'Lantern Relay.exe'));
  requireMatch('Relay UI Windows instalador', relayUiDir, /^LanternRelay-Setup-.*\.exe$/i);
  requireMatch('Relay UI Linux AppImage', relayUiDir, /^LanternRelay-.*\.AppImage$/i);
};

let buildError = null;

try {
  ensureDependencies();

  run('Compilando o renderer compartilhado', npm, ['run', 'build:renderer']);
  run('Compilando o cliente Electron', npm, ['run', 'build:electron']);
  run('Compilando o Relay UI', npm, ['run', 'build:relay-ui']);

  run('Preparando módulo nativo macOS x64', npm, ['run', 'prepare:mac:universal:native']);
  run('Lantern — macOS universal (.app + .dmg)', npx, builderArgs(null, ['--mac', '--universal']));

  const relayUiConfig = 'electron-builder.relay-ui.json';
  run('Preparando módulo nativo macOS x64 para o Relay UI', npm, ['run', 'prepare:mac:universal:native']);
  run('Relay UI — macOS universal (.app + .dmg)', npx, builderArgs(relayUiConfig, ['--mac', '--universal']));

  run('Lantern — Windows x64 (instalador + win-unpacked)', npx, windowsArgs(null));
  run('Relay UI — Windows x64 (instalador + win-unpacked)', npx, windowsArgs(relayUiConfig));

  run('Lantern — Linux x64 (AppImage)', npx, builderArgs(null, ['--linux', '--x64']));
  run('Relay UI — Linux x64 (AppImage)', npx, builderArgs(relayUiConfig, ['--linux', '--x64']));

  validateArtifacts();
  console.log('\n[Lantern build] Todos os artefatos foram gerados.');
} catch (error) {
  buildError = error;
} finally {
  if (!skipNativeRepair) {
    try {
      run('Restaurando dependências nativas para desenvolvimento no Mac', npm, ['run', 'rebuild:native']);
    } catch (repairError) {
      if (!buildError) buildError = repairError;
      const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
      console.error(`\n[Lantern build] Falha ao restaurar dependências nativas: ${repairMessage}`);
    }
  }
}

if (buildError) {
  const message = buildError instanceof Error ? buildError.message : String(buildError);
  console.error(`\n[Lantern build] ERRO: ${message}`);
  process.exit(1);
}
