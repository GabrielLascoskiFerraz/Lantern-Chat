const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');

if (process.platform !== 'darwin') {
  console.error('[Lantern build] A preparação universal deve ser executada no macOS.');
  process.exit(1);
}

const moduleDir = path.join(projectRoot, 'node_modules', 'better-sqlite3');
const prebuildInstall = path.join(projectRoot, 'node_modules', '.bin', 'prebuild-install');
const electronPackage = path.join(projectRoot, 'node_modules', 'electron', 'package.json');

if (!fs.existsSync(moduleDir) || !fs.existsSync(prebuildInstall) || !fs.existsSync(electronPackage)) {
  console.error('[Lantern build] Dependências ausentes. Execute npm ci antes do build.');
  process.exit(1);
}

const electronVersion = JSON.parse(fs.readFileSync(electronPackage, 'utf8')).version;
const result = spawnSync(
  prebuildInstall,
  [
    '--runtime=electron',
    `--target=${electronVersion}`,
    '--arch=x64',
    '--platform=darwin',
    '--force'
  ],
  {
    cwd: moduleDir,
    stdio: 'inherit',
    shell: false
  }
);

if (result.error) {
  console.error(`[Lantern build] Falha ao preparar better-sqlite3 x64: ${result.error.message}`);
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

console.log(`[Lantern build] better-sqlite3 preparado para Electron ${electronVersion} macOS x64.`);
