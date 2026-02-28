const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

const showHelp = () => {
  console.log(`
Uso:
  node ./scripts/build-mac-win-from-mac.cjs [opcoes]

Opcoes:
  --dry-run             Mostra os comandos sem executar.
  --skip-install        Nao roda npm ci quando node_modules estiver ausente.
  --skip-native-repair  Nao executa npm run rebuild:native no final.
  --win-skip-rcedit     Desabilita edicao de icone/metadados do .exe (usar so se Wine falhar).
  --help                Exibe esta ajuda.

Saida esperada:
  dist-installers/Lantern-<versao>-<arch>.dmg
  dist-installers/Lantern-<versao>-<arch>.zip
  dist-installers/Lantern-Setup-<versao>.exe
  dist-relay/LanternRelay-mac-<arch>
  dist-relay/LanternRelay.exe
`);
};

if (args.has('--help')) {
  showHelp();
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.error('[Lantern build] Este script deve ser executado no macOS.');
  process.exit(1);
}

const dryRun = args.has('--dry-run');
const skipInstall = args.has('--skip-install');
const skipNativeRepair = args.has('--skip-native-repair');
const winSkipRcedit = args.has('--win-skip-rcedit');

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const macArchFlag = process.arch === 'arm64' ? '--arm64' : '--x64';
const relayMacTargetArg = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';

const run = (label, command, commandArgs) => {
  const rendered = `${command} ${commandArgs.join(' ')}`;
  console.log(`[Lantern build] ${label}`);
  console.log(`[Lantern build] $ ${rendered}`);
  if (dryRun) return;

  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`Falha em: ${label} (exit=${result.status ?? 'desconhecido'})`);
  }
};

const ensureInstallIfNeeded = () => {
  const nodeModulesPath = path.join(projectRoot, 'node_modules');
  if (fs.existsSync(nodeModulesPath)) return;
  if (skipInstall) {
    throw new Error(
      'node_modules nao encontrado e --skip-install foi informado. Rode npm ci antes do build.'
    );
  }
  run('Instalando dependencias (node_modules ausente)', npmCmd, ['ci']);
};

const main = () => {
  ensureInstallIfNeeded();

  run('Build do renderer', npmCmd, ['run', 'build:renderer']);
  run('Build do processo Electron', npmCmd, ['run', 'build:electron']);

  run('Gerando instalador macOS', npxCmd, [
    '--yes',
    'electron-builder',
    '--mac',
    macArchFlag,
    '--publish',
    'never'
  ]);

  const windowsBuildArgs = [
    '--yes',
    'electron-builder',
    '--win',
    '--x64',
    '--publish',
    'never'
  ];
  if (winSkipRcedit) {
    windowsBuildArgs.push('-c.win.signAndEditExecutable=false');
  }
  run('Gerando instalador Windows x64', npxCmd, windowsBuildArgs);

  run('Build do Relay (TypeScript)', npmCmd, ['run', 'build:relay']);
  run('Gerando binario do Relay para macOS', process.execPath, [
    './scripts/build-relay-bin.cjs',
    relayMacTargetArg
  ]);
  run('Gerando binario do Relay para Windows x64', process.execPath, [
    './scripts/build-relay-bin.cjs',
    'win'
  ]);

  if (!skipNativeRepair) {
    run('Restaurando dependencias nativas para o macOS (dev local)', npmCmd, [
      'run',
      'rebuild:native'
    ]);
  }

  console.log('[Lantern build] Concluido.');
};

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Lantern build] ERRO: ${message}`);
  process.exit(1);
}
